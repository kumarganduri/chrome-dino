// Stand-in for chrome://resources/js/load_time_data.js. Chrome fills this with
// page strings/flags; we expose none, which keeps the runner on its default
// path: easter egg enabled, no alt game mode, default English a11y strings.
export const loadTimeData = {
  valueExists(_id: string): boolean {
    return false;
  },
  getValue(_id: string): unknown {
    return undefined;
  },
  getString(_id: string): string {
    return '';
  },
  getBoolean(_id: string): boolean {
    return false;
  },
  getInteger(_id: string): number {
    return 0;
  },
};
