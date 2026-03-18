import { App } from "obsidian";
import * as crypto from "crypto";
import * as http from "http";
import { URL } from "url";
import { DriveCredentials, PluginSettings } from "../types";

// Electron shell — marked external in esbuild so it resolves at runtime
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shell } = require("electron") as typeof import("electron");

const CREDENTIALS_PATH = ".obsidian/drive-sync-credentials.json";
const REDIRECT_PORT = 42813;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const LOG = "[DriveSync/Auth]";

export class GoogleAuth {
	constructor(private app: App, private settings: PluginSettings) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	async isAuthorized(): Promise<boolean> {
		const creds = await this.loadCredentials();
		const authorized = creds !== null;
		console.log(`${LOG} isAuthorized:`, authorized);
		return authorized;
	}

	async authorize(): Promise<void> {
		console.log(`${LOG} Starting OAuth2 flow`);
		const verifier = this.generateCodeVerifier();
		const challenge = this.generateCodeChallenge(verifier);

		const params = new URLSearchParams({
			client_id: this.settings.clientId,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${AUTH_URL}?${params}`;
		console.log(`${LOG} Auth URL:`, authUrl);

		// Start server BEFORE opening browser to avoid race condition
		console.log(`${LOG} Starting localhost callback server on port`, REDIRECT_PORT);
		const codePromise = this.waitForAuthCode();

		console.log(`${LOG} Opening browser for user consent`);
		await shell.openExternal(authUrl);

		console.log(`${LOG} Waiting for auth code from callback…`);
		const code = await codePromise;
		console.log(`${LOG} Auth code received — exchanging for tokens`);

		await this.exchangeCode(code, verifier);
		console.log(`${LOG} Authorization complete — credentials saved`);
	}

	async getValidAccessToken(): Promise<string> {
		const creds = await this.loadCredentials();
		if (!creds) {
			throw new Error(
				"Not authenticated. Please connect to Google Drive in plugin settings."
			);
		}

		const expiresIn = Math.round((creds.expiry - Date.now()) / 1000);
		console.log(`${LOG} Access token expires in ${expiresIn}s`);

		if (Date.now() < creds.expiry - 60_000) {
			console.log(`${LOG} Using cached access token`);
			return creds.access_token;
		}

		console.log(`${LOG} Token expired or expiring soon — refreshing`);
		return this.refreshAccessToken(creds.refresh_token);
	}

	async disconnect(): Promise<void> {
		console.log(`${LOG} Disconnecting — removing credentials`);
		const exists = await this.app.vault.adapter.exists(CREDENTIALS_PATH);
		if (exists) {
			await this.app.vault.adapter.remove(CREDENTIALS_PATH);
			console.log(`${LOG} Credentials removed`);
		} else {
			console.log(`${LOG} No credentials file found`);
		}
	}

	private async exchangeCode(code: string, verifier: string): Promise<void> {
		console.log(`${LOG} POST ${TOKEN_URL} (grant_type=authorization_code)`);
		const resp = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				redirect_uri: REDIRECT_URI,
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
			}),
		});

		if (!resp.ok) {
			const body = await resp.text();
			console.error(`${LOG} Token exchange failed — status ${resp.status}:`, body);
			throw new Error(`Authorization failed: ${resp.status} ${body}`);
		}

		const data = await resp.json();
		console.log(`${LOG} Token exchange response fields:`, Object.keys(data));

		if (!data.refresh_token) {
			throw new Error(
				"No refresh token returned. Ensure prompt=consent and access_type=offline are set."
			);
		}

		await this.saveCredentials({
			refresh_token: data.refresh_token,
			access_token: data.access_token,
			expiry: Date.now() + data.expires_in * 1000,
		});
	}

	private async refreshAccessToken(refreshToken: string): Promise<string> {
		console.log(`${LOG} POST ${TOKEN_URL} (grant_type=refresh_token)`);
		const resp = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		});

		if (!resp.ok) {
			const body = await resp.text();
			console.error(`${LOG} Token refresh failed — status ${resp.status}:`, body);
			throw new Error(`Token refresh failed: ${resp.status} ${body}`);
		}

		const data = await resp.json();
		console.log(`${LOG} Token refresh successful — new expiry in ${data.expires_in}s`);

		const newCreds: DriveCredentials = {
			refresh_token: refreshToken,
			access_token: data.access_token,
			expiry: Date.now() + data.expires_in * 1000,
		};

		await this.saveCredentials(newCreds);
		return newCreds.access_token;
	}

	private waitForAuthCode(): Promise<string> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				try {
					console.log(`${LOG} Callback received:`, req.url);
					const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
					const code = url.searchParams.get("code");
					const error = url.searchParams.get("error");

					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<h1>Authorization complete.</h1><p>You can close this tab and return to Obsidian.</p>"
					);

					server.close();

					if (code) {
						console.log(`${LOG} Auth code extracted from callback`);
						resolve(code);
					} else {
						console.error(`${LOG} Callback contained error:`, error);
						reject(new Error(error ?? "No authorization code received"));
					}
				} catch (e) {
					console.error(`${LOG} Error handling callback:`, e);
					server.close();
					reject(e);
				}
			});

			server.listen(REDIRECT_PORT, "127.0.0.1", () => {
				console.log(`${LOG} Callback server listening on`, REDIRECT_URI);
			});

			server.on("error", (err) => {
				console.error(`${LOG} Callback server error:`, err);
				reject(new Error(`Failed to start auth server: ${err.message}`));
			});

			const timeout = setTimeout(() => {
				console.error(`${LOG} Auth timed out after 5 minutes`);
				server.close();
				reject(new Error("Authorization timed out after 5 minutes"));
			}, 5 * 60 * 1000);

			server.on("close", () => clearTimeout(timeout));
		});
	}

	private async saveCredentials(creds: DriveCredentials): Promise<void> {
		console.log(`${LOG} Saving credentials to`, CREDENTIALS_PATH);
		await this.app.vault.adapter.write(
			CREDENTIALS_PATH,
			JSON.stringify(creds, null, 2)
		);
	}

	private async loadCredentials(): Promise<DriveCredentials | null> {
		try {
			const exists = await this.app.vault.adapter.exists(CREDENTIALS_PATH);
			if (!exists) {
				console.log(`${LOG} No credentials file found at`, CREDENTIALS_PATH);
				return null;
			}
			const raw = await this.app.vault.adapter.read(CREDENTIALS_PATH);
			return JSON.parse(raw) as DriveCredentials;
		} catch (e) {
			console.error(`${LOG} Failed to load credentials:`, e);
			return null;
		}
	}

	private generateCodeVerifier(): string {
		return crypto.randomBytes(32).toString("base64url");
	}

	private generateCodeChallenge(verifier: string): string {
		return crypto.createHash("sha256").update(verifier).digest("base64url");
	}
}
