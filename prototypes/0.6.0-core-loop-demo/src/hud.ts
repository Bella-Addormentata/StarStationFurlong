/**
 * Debug HUD updater — small utility shared by main.ts and player.ts
 * to avoid a circular-import chain (main → world → player → main).
 */
export function updateDebugHUD(elementId: string, value: string): void {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}
