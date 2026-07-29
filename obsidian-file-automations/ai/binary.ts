/**
 * Convert binary data to base64 using browser primitives. Chunking prevents
 * argument/string limits on mobile WebViews for large PDFs.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	// Divisible by three so independently encoded chunks concatenate without
	// intermediate padding.
	const chunkSize = 3 * 8192;
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const end = Math.min(offset + chunkSize, bytes.length);
		let binary = "";
		for (let index = offset; index < end; index++) binary += String.fromCharCode(bytes[index]);
		chunks.push(btoa(binary));
	}
	return chunks.join("");
}
