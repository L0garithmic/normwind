// Covers complex equivalences:
//   content-center + justify-center -> place-content-center
//   items-start + justify-items-start -> place-items-start
//   self-end + justify-self-end -> place-self-end

export const PlaceContent = () => (
    <div className="content-center justify-center grid">place content</div>
);

export const PlaceItems = () => (
    <div className="items-start justify-items-start grid">place items</div>
);

export const PlaceSelf = () => (
    <div className="self-end justify-self-end">place self</div>
);
