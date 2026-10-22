/**
 * The deployed build, stamped by next.config.js (the git commit). A page
 * compares its own stamp with the server's to notice it was loaded before a
 * deploy: an old tab keeps running the planner it loaded.
 */
export const APP_BUILD = process.env.NEXT_PUBLIC_APP_BUILD || "dev";
