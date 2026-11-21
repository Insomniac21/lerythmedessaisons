import { assertWritable } from "../../../ecrire/generer.js";

export function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      const row = store.get(key);
      if (!row) return null;
      if (row.exp && Date.now() > row.exp) {
        store.delete(key);
        return null;
      }
      return row.value;
    },
    async put(key, value, options = {}) {
      const exp = options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0;
      store.set(key, { value: String(value), exp });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export function createMemoryGitHub(initial = {}) {
  const files = new Map(Object.entries(initial));
  const commits = [];
  return {
    files,
    commits,
    async readText(filePath) {
      assertWritable(filePath);
      if (!files.has(filePath)) return null;
      const value = files.get(filePath);
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
      return null;
    },
    async commit({ message, files: next, deletes }) {
      for (const filePath of Object.keys(next)) assertWritable(filePath);
      for (const filePath of deletes || []) assertWritable(filePath);
      for (const [filePath, file] of Object.entries(next)) {
        files.set(filePath, file.text != null ? file.text : file.bytes);
      }
      for (const filePath of deletes || []) files.delete(filePath);
      commits.push({ message, paths: Object.keys(next), deletes: [...(deletes || [])] });
    },
  };
}
