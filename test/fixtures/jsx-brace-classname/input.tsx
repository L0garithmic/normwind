export const Ternary = ({ active }: { active: boolean }) => (
    <div className={active ? "px-4 py-4" : "pl-2 pr-2"}>ternary</div>
);

export const TemplateLiteral = ({ size }: { size: number }) => (
    <div className={`w-6 h-6 shrink-0 h-${size} mt-1 mb-1`}>template literal</div>
);
