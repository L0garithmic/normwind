// Border-radius corner shorthand
//   rounded-tl-lg rounded-tr-lg -> rounded-t-lg
//   rounded-tl-md rounded-tr-md rounded-br-md rounded-bl-md -> rounded-md

export const TopRadius = () => (
    <div className="rounded-tl-lg rounded-tr-lg">top corners</div>
);

export const AllRadius = () => (
    <div className="rounded-tl-md rounded-tr-md rounded-br-md rounded-bl-md">all corners</div>
);
