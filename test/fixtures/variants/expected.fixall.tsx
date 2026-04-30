// Variant-prefixed shorthand:
//   md:px-4 md:py-4 -> md:p-4
//   hover:w-8 hover:h-8 -> hover:size-8
//   dark:mt-2 dark:mb-2 -> dark:my-2

export const ResponsivePadding = () => (
    <div className="md:p-4">responsive padding</div>
);

export const HoverSize = () => (
    <div className="hover:size-8">hover size</div>
);

export const DarkMargin = () => (
    <div className="dark:my-2">dark margin</div>
);
