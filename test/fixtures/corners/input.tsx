// Border-radius corner / four-sides family shorthand:
//   rounded-tl-lg rounded-tr-lg -> rounded-t-lg
//   rounded-tl-md rounded-tr-md rounded-br-md rounded-bl-md -> rounded-t-md rounded-b-md
//     (corner pairs merge into sides; the audit reports no t+b -> rounded step
//     because the radius family has no y shorthand, and the fixer mirrors it)
//   rounded-t-xl rounded-r-xl rounded-b-xl rounded-l-xl -> rounded-xl
//   border-t border-r border-b border-l -> border
//   hover:rounded-tl-lg hover:rounded-tr-lg -> hover:rounded-t-lg
//
// Negative cases that MUST NOT merge:
//   - diagonal corners only (no adjacent pair): rounded-tl-sm rounded-br-sm
//   - three of four corners with mismatched values
//   - three of four sides, even with identical values
//   - identical corners under different variant prefixes

export const TopRadius = () => (
    <div className="rounded-tl-lg rounded-tr-lg">top corners</div>
);

export const AllRadius = () => (
    <div className="rounded-tl-md rounded-tr-md rounded-br-md rounded-bl-md">all corners</div>
);

export const AllSideRadius = () => (
    <div className="rounded-t-xl rounded-r-xl rounded-b-xl rounded-l-xl">all sides</div>
);

export const BorderSides = () => (
    <div className="border-t border-r border-b border-l">border box</div>
);

export const HoverCorners = () => (
    <div className="hover:rounded-tl-lg hover:rounded-tr-lg">hover corners</div>
);

export const DiagonalCorners = () => (
    <div className="rounded-tl-sm rounded-br-sm">diagonal corners</div>
);

export const ThreeCornersMixedValues = () => (
    <div className="rounded-tl-sm rounded-tr-xl rounded-br-sm">three corners</div>
);

export const ThreeSides = () => (
    <div className="rounded-t-2xl rounded-r-2xl rounded-b-2xl">three sides</div>
);

export const MixedVariants = () => (
    <div className="hover:rounded-bl-lg rounded-br-lg">mixed variants</div>
);
