// Size limit checks for PDF attachments. Run: cd web && pnpm dlx tsx src/session/composer/pdfLimits.check.ts
import { fitsPdf, MAX_FILE_SIZE, MAX_MESSAGE_SIZE, pdfBytes } from './pdfLimits';

/** Throw unless `got` equals `want` (compared as JSON). */
const eq = (got: unknown, want: unknown, what: string) => {
  const gotJson = JSON.stringify(got),
    wantJson = JSON.stringify(want);
  if (gotJson !== wantJson) throw new Error(`${what}: got ${gotJson}, want ${wantJson}`);
};

// 1. Single file > 3.5MB rejected with 'file-too-big'
eq(
  fitsPdf({ size: 3_500_001, usedBytes: 0 }),
  'file-too-big',
  'single file exceeding 3.5MB is rejected with file-too-big',
);
eq(
  fitsPdf({ size: 4_000_000, usedBytes: 1_000_000 }),
  'file-too-big',
  'single file exceeding individual limit takes precedence over message limit',
);

// 2. Fits individually but exceeds message total rejected with 'message-too-big'
eq(
  fitsPdf({ size: 1_000_000, usedBytes: 2_600_000 }),
  'message-too-big',
  'file exceeding remaining message budget is rejected with message-too-big',
);

// 3. Fits within remaining accepted with 'ok'
eq(
  fitsPdf({ size: 1_000_000, usedBytes: 2_000_000 }),
  'ok',
  'file fitting within individual and message budget is accepted with ok',
);
eq(fitsPdf({ size: 500_000, usedBytes: 0 }), 'ok', 'small file with 0 used bytes is accepted with ok');

// 4. Exact 3,500,000 bytes boundary
eq(
  fitsPdf({ size: MAX_MESSAGE_SIZE, usedBytes: 0 }),
  'ok',
  'file exactly at 3,500,000 bytes boundary with 0 used is accepted with ok',
);
eq(
  fitsPdf({ size: 1_500_000, usedBytes: 2_000_000 }),
  'ok',
  'file exactly reaching 3,500,000 bytes total is accepted with ok',
);
eq(
  fitsPdf({ size: 1_500_001, usedBytes: 2_000_000 }),
  'message-too-big',
  'file tipping total to 3,500,001 bytes is rejected with message-too-big',
);

// 5. pdfBytes sums correctly
eq(pdfBytes([]), 0, 'empty list sums to 0');
eq(pdfBytes([100, 200, 300]), 600, 'list of sizes sums correctly');
eq(pdfBytes([MAX_FILE_SIZE]), MAX_FILE_SIZE, 'single size sums correctly');

console.log('pdfLimits: ok');
