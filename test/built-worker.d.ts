/** The Astro-built Worker bundle the pool serves; tests call its cron handler directly. */
declare module '../dist/server/entry.mjs' {
  const worker: ExportedHandler<Cloudflare.Env>
  export default worker
}
