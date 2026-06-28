import {
  exportMedalModel,
  getModelExportOption,
} from "@/lib/export-model";
import {
  exportPresentationAnimation,
  getPresentationExportOption,
} from "@/lib/presentation-export";
import type {
  ExportWorkerMessage,
  ExportWorkerRequest,
} from "@/lib/export-worker-types";

type WorkerSvgStyle = Record<string, string | number | undefined>;

const SVG_TAG_PATTERN =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^>]+>/g;
const SVG_ATTRIBUTE_PATTERN = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
const SVG_CSS_RULE_PATTERN = /([^{}]+)\{([^{}]*)\}/g;

class WorkerSvgDocument {
  constructor(readonly documentElement: WorkerSvgElement) {}
}

class WorkerSvgElement {
  readonly childNodes: WorkerSvgElement[] = [];
  readonly nodeType = 1;
  readonly sheet?: { cssRules: WorkerSvgCssRule[] };
  readonly style: WorkerSvgStyle;
  viewportElement: WorkerSvgElement | null = null;

  constructor(
    readonly nodeName: string,
    private readonly attributes: Record<string, string>,
    textContent = "",
  ) {
    this.style = parseWorkerSvgStyle(attributes.style ?? "");

    if (nodeName === "style") {
      this.sheet = {
        cssRules: parseWorkerSvgCssRules(textContent),
      };
    }
  }

  appendChild(child: WorkerSvgElement) {
    this.childNodes.push(child);
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  getAttributeNS(_namespace: string, name: string) {
    return (
      this.attributes[name] ??
      this.attributes[`xlink:${name}`] ??
      this.attributes[`svg:${name}`] ??
      null
    );
  }

  getElementById(id: string): WorkerSvgElement | null {
    if (this.attributes.id === id) {
      return this;
    }

    for (const child of this.childNodes) {
      const match = child.getElementById(id);
      if (match) {
        return match;
      }
    }

    return null;
  }

  hasAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
}

class WorkerSvgCssRule {
  readonly type = 1;
  readonly style: WorkerSvgStyle;

  constructor(
    readonly selectorText: string,
    declarations: string,
  ) {
    this.style = parseWorkerSvgStyle(declarations);
  }
}

class WorkerSvgDomParser {
  parseFromString(text: string) {
    return new WorkerSvgDocument(parseWorkerSvg(text));
  }
}

function installWorkerDomParser() {
  const globalWithDomParser = globalThis as typeof globalThis & {
    DOMParser?: typeof DOMParser;
  };

  globalWithDomParser.DOMParser ??=
    WorkerSvgDomParser as unknown as typeof DOMParser;
}

function parseWorkerSvg(text: string) {
  const root = new WorkerSvgElement("svg", {});
  const stack: WorkerSvgElement[] = [root];
  let rootElement: WorkerSvgElement | null = null;
  let match: RegExpExecArray | null;

  while ((match = SVG_TAG_PATTERN.exec(text))) {
    const token = match[0];

    if (
      token.startsWith("<!--") ||
      token.startsWith("<?") ||
      token.startsWith("<!") ||
      token.startsWith("</")
    ) {
      if (token.startsWith("</") && stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const parsedTag = parseWorkerSvgTag(token);
    if (!parsedTag) {
      continue;
    }

    const element = new WorkerSvgElement(
      parsedTag.nodeName,
      parsedTag.attributes,
      parsedTag.textContent,
    );
    const parent = stack[stack.length - 1];
    parent.appendChild(element);
    rootElement ??= element;

    if (!parsedTag.selfClosing) {
      stack.push(element);
    }
  }

  const documentElement = rootElement ?? root;
  assignWorkerSvgViewport(documentElement, documentElement);
  return documentElement;
}

function parseWorkerSvgTag(token: string) {
  const openTag = token.slice(1, token.endsWith("/>") ? -2 : -1).trim();
  if (!openTag) {
    return null;
  }

  const nameMatch = openTag.match(/^([^\s/>]+)/);
  const rawName = nameMatch?.[1] ?? "";
  const nodeName = rawName.includes(":")
    ? rawName.slice(rawName.indexOf(":") + 1)
    : rawName;
  const attributes: Record<string, string> = {};

  for (const attributeMatch of openTag.matchAll(SVG_ATTRIBUTE_PATTERN)) {
    attributes[attributeMatch[1]] = attributeMatch[3] ?? attributeMatch[4] ?? "";
  }

  return {
    attributes,
    nodeName,
    selfClosing: token.endsWith("/>"),
    textContent: "",
  };
}

function assignWorkerSvgViewport(
  element: WorkerSvgElement,
  viewportElement: WorkerSvgElement,
) {
  element.viewportElement = viewportElement;

  for (const child of element.childNodes) {
    assignWorkerSvgViewport(child, viewportElement);
  }
}

function parseWorkerSvgCssRules(text: string) {
  const rules: WorkerSvgCssRule[] = [];
  let match: RegExpExecArray | null;

  while ((match = SVG_CSS_RULE_PATTERN.exec(text))) {
    rules.push(new WorkerSvgCssRule(match[1].trim(), match[2]));
  }

  return rules;
}

function parseWorkerSvgStyle(text: string): WorkerSvgStyle {
  const style: WorkerSvgStyle = {};

  for (const declaration of text.split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const rawName = declaration.slice(0, separatorIndex).trim();
    const value = declaration.slice(separatorIndex + 1).trim();
    if (!rawName || !value) {
      continue;
    }

    const camelName = rawName.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    style[rawName] = value;
    style[camelName] = value;
  }

  return new Proxy(style, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }

      return property in target ? Reflect.get(target, property, receiver) : "";
    },
  });
}

installWorkerDomParser();

function postWorkerMessage(message: ExportWorkerMessage, transfer?: Transferable[]) {
  self.postMessage(message, { transfer });
}

self.onmessage = async (event: MessageEvent<ExportWorkerRequest>) => {
  const request = event.data;

  try {
    const blob =
      request.kind === "presentation"
        ? await exportPresentationAnimation(
            request.svgText,
            request.settings,
            request.format,
            request.config,
            {
              onProgress: (progress) => {
                postWorkerMessage({
                  id: request.id,
                  progress,
                  type: "progress",
                });
              },
            },
          )
        : await exportMedalModel(
            request.svgText,
            request.settings,
            request.format,
            {
              onProgress: (progress) => {
                postWorkerMessage({
                  id: request.id,
                  progress,
                  type: "progress",
                });
              },
            },
          );
    const buffer = await blob.arrayBuffer();

    postWorkerMessage(
      {
        buffer,
        id: request.id,
        mimeType:
          request.kind === "presentation"
            ? getPresentationExportOption(request.format).mimeType
            : getModelExportOption(request.format).mimeType,
        sizeBytes: buffer.byteLength,
        type: "complete",
      },
      [buffer],
    );
  } catch (error) {
    postWorkerMessage({
      error: error instanceof Error ? error.message : "Export failed",
      id: request.id,
      type: "error",
    });
  }
};

export {};
