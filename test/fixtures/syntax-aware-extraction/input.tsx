import React from "react";
import { createElement as vueCreateElement, h as hyperscript } from "vue";

declare const dynamic: string;
declare function track(value: unknown): void;

const unrelatedData = { class: "px-4 py-4" };
const serializedHtml = '<div class="mt-2 mb-2">serialized</div>';
const serializedTemplate = `<div className="w-4 h-4">serialized</div>`;
const serializedPattern = /class="pl-2 pr-2"/;

// <div className="pt-4 pb-4">comment</div>
track({ class: "ml-3 mr-3" });

export const Hyperscript = hyperscript("div", { class: "px-4 py-4" });
export const ReactElement = React.createElement("div", { className: "mt-2 mb-2" });
export const ImportedAlias = vueCreateElement("div", {
    class: `w-4 h-4 ${dynamic}`,
});
export const JsxElement = <div className="pl-2 pr-2">rendered</div>;

void unrelatedData;
void serializedHtml;
void serializedTemplate;
void serializedPattern;
