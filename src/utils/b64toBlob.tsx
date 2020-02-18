/**
 *
 *
 * @export
 * @param {string} dataURI
 * @param {string} name
 * @return {File}
 */
export function b64toBlob(dataURI: string, name: string) {
  const byteString = atob(dataURI.split(',')[1]);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  return new File([ab], name, {
    type: dataURI.replace(/(.*:)|;(.*)/g, ''),
  });
}
