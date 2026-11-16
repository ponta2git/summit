/** Keep diagnostic sink failures from changing committed results or resource ownership. */
export const reportSafely = (report: () => void): void => {
  try { report(); }
  catch { /* why: 診断先の障害を同じ診断先へ再報告せず、業務処理と回復を継続する。 */ }
};
