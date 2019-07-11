export const extractFiles = (
  value: File | Blob | FileList | any,
  path: string = '',
): {
  clone: any;
  files: Map<any, any>;
} => {
  let clone: any;
  const files = new Map();
  /**
   * Adds a file to the extracted files map.
   * @kind function
   * @name extractFiles~addFile
   * @param {ObjectPath[]} path File object paths.
   * @param {ExtractableFile} file Extracted file.
   * @ignore
   */
  function addFile(path: string, file: File | Blob) {
    files.set(path, file);
  }
  if (
    (typeof File !== 'undefined' && value instanceof File) ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  ) {
    clone = null;
    addFile(path, value);
  } else {
    const prefix = path ? `${path}.` : '';
    if (typeof FileList !== 'undefined' && value instanceof FileList)
      clone = Array.from(value).map((file: File, i: number) => {
        addFile(`${prefix}${i}`, file);
        return null;
      });
    else if (Array.isArray(value))
      clone = value.map((child, i) => {
        const result = extractFiles(child, `${prefix}${i}`);
        result.files.forEach((a, b) => addFile(b, a));
        return result.clone;
      });
    else if (value && value.constructor === Object) {
      clone = {};
      for (const i in value) {
        const result = extractFiles(
          (value as any)[i],
          `${prefix}${i}`,
        );
        result.files.forEach((a, b) => addFile(b, a));
        clone[i] = result.clone;
      }
    } else clone = value;
  }
  return { clone, files };
};
