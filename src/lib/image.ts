/** Downscales a camera photo before upload (phones produce 4–12 MB images). Returns a JPEG. */
export async function compressImage(file: File, maxEdge = 1600, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a photo.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('That photo could not be read. Try taking it again.');
  }
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('That photo could not be prepared. Try again.');
  return blob;
}
