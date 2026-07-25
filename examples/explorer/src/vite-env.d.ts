/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** JSON array: [{"name":"Preview","apiUrl":"http://…:3100","color":"#f0b429"}, …] */
  readonly VITE_NETWORKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
