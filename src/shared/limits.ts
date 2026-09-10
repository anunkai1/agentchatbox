/** Shared transport limits for prompt image attachments. */
export const MAX_PROMPT_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 300 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 20;

// 300 MiB becomes about 400 MiB of base64. Leave room for escaped prompt
// text/JSON metadata while staying below Node's ~512 MiB string-length cap.
export const MAX_PI_RPC_LINE_CHARS = 448 * 1024 * 1024;
