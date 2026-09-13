// Pi's native clipboard flow inserts a host path, not image bytes. JSON quoting
// delimits spaces/quotes without pretending this is a shell command. No controls.
export function piImageReference(path: string): string {
  if (!path.startsWith("/") || /[\x00-\x1f\x7f-\x9f]/.test(path))
    throw new Error(
      "The image path must be absolute and contain no control characters.",
    );
  return ` ${JSON.stringify(path)} `;
}
