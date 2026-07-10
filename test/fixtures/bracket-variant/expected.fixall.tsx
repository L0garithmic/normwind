// Bracket-variant / arbitrary-selector shorthand:
//   data-[state=open]:px-4 data-[state=open]:py-4 -> data-[state=open]:p-4
//   [&>svg]:w-4 [&>svg]:h-4 -> [&>svg]:size-4
//
// Regression fixture for the audit/fix classifier-parity bug: bracket
// contents contain operator characters (`=`, `>`, `&`) that must not
// disqualify the token OUTSIDE the brackets. isLikelyTailwindUtility (audit)
// and isLikelyFixUtility (fix) must agree on both examples below.
//
// NOTE: plain --fix only rewrites .vue files by design, so expected.fixed.tsx
// must stay byte-identical to input.tsx. The classifier-parity guarantee is
// exercised by the --fixall baseline (expected.fixall.tsx).

export const BracketVariant = () => (
    <div className="data-[state=open]:p-4">bracket variant</div>
);

export const NestedSelector = () => (
    <div className="[&>svg]:size-4">nested selector</div>
);
