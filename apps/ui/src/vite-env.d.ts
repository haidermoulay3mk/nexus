/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NEXUS_PORT?: string;
  readonly VITE_NEXUS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
