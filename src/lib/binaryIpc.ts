import { invoke } from '@tauri-apps/api/core'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_EDITOR_GROUP_BYTES = 10 * 1024 * 1024

/** Keep file bytes out of JSON; only the small UTF-8 metadata travels in a header. */
export function binaryMetadataHeader(metadata: { file_name?: string; extension?: string; path?: string }) {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata))
  if (bytes.length > 8192) throw new Error('文件名或保存路径过长')
  return btoa(String.fromCharCode(...bytes))
}
export function invokeBinary<T>(command: string, bytes: Uint8Array, metadata: Parameters<typeof binaryMetadataHeader>[0]) {
  return invoke<T>(command, bytes, { headers: { 'x-file-metadata': binaryMetadataHeader(metadata) } })
}
export async function readFileBytes(file: File, maxBytes: number, label: string) {
  if (!file.size || file.size > maxBytes) throw new Error(`${label}不能为空，且不能超过 ${maxBytes / 1024 / 1024} MB`)
  return new Uint8Array(await file.arrayBuffer())
}
