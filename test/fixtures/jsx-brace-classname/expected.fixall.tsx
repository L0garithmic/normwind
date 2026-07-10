export const Ternary = ({ active }: { active: boolean }) => (
    <div className={active ? "p-4" : "px-2"}>ternary</div>
);

export const TemplateLiteral = ({ size }: { size: number }) => (
    <div className={`size-6 shrink-0 h-${size} my-1`}>template literal</div>
);
