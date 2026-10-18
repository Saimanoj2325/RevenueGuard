// Fallback ambient declarations for editor when node_modules is inside Docker
declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_MOCK?: string;
    NEXT_PUBLIC_API_URL?: string;
    NEXT_PUBLIC_WS_URL?: string;
    NEXT_PUBLIC_BASE_PATH?: string;
    INTERNAL_API_URL?: string;
    NODE_ENV?: string;
    [key: string]: string | undefined;
  }
}

declare const process: {
  env: NodeJS.ProcessEnv;
};
