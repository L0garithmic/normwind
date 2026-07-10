// Covers padding/margin family shorthand:
//   px-4 py-4 -> p-4
//   pl-2 pr-2 -> px-2
//   mt-3 mb-3 -> my-3

export function PaddingShorthand() {
    return <div className="p-4 text-base">all sides padding</div>;
}

export function PaddingXShorthand() {
    return <div className="px-2 bg-white">left+right padding</div>;
}

export function MarginYShorthand() {
    return <div className="my-3 block">top+bottom margin</div>;
}
