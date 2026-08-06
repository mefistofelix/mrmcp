// src/morphlex.ts
var SUPPORTS_MOVE_BEFORE = "moveBefore" in Element.prototype;
var ELEMENT_NODE_TYPE = 1;
var TEXT_NODE_TYPE = 3;
var IS_PARENT_NODE_TYPE = [
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  1,
  0
];
var Operation = {
  EqualNode: 0,
  SameElement: 1,
  SameNode: 2
};
var candidateNodes = new Set;
var candidateElements = new Set;
var candidateElementsWithIds = new Set;
var unmatchedNodes = new Set;
var unmatchedElements = new Set;
var whitespaceNodes = new Set;
function morphDocument(from, to, options) {
  if (typeof to === "string")
    to = parseDocument(to);
  morph(from.documentElement, to.documentElement, options);
}
function morph(from, to, options = {}) {
  if (typeof to === "string")
    to = parseFragment(to).childNodes;
  if (!options.preserveChanges && isParentNode(from))
    flagDirtyInputs(from);
  new Morph(options).morph(from, to);
}
function morphInner(from, to, options = {}) {
  if (typeof to === "string") {
    const fragment = parseFragment(to);
    if (fragment.firstChild && fragment.childNodes.length === 1 && fragment.firstChild.nodeType === ELEMENT_NODE_TYPE) {
      to = fragment.firstChild;
    } else {
      throw new Error("[Morphlex] The string was not a valid HTML element.");
    }
  }
  if (from.nodeType === ELEMENT_NODE_TYPE && to.nodeType === ELEMENT_NODE_TYPE && from.localName === to.localName) {
    if (isParentNode(from))
      flagDirtyInputs(from);
    new Morph(options).visitChildNodes(from, to);
  } else {
    throw new Error("[Morphlex] You can only do an inner morph with matching elements.");
  }
}
function flagDirtyInputs(node) {
  for (const input of node.querySelectorAll("input")) {
    if (input.name && input.value !== input.defaultValue || input.checked !== input.defaultChecked) {
      input.setAttribute("morphlex-dirty", "");
    }
  }
  for (const element of node.querySelectorAll("option")) {
    if (element.value && element.selected !== element.defaultSelected) {
      element.setAttribute("morphlex-dirty", "");
    }
  }
  for (const element of node.querySelectorAll("textarea")) {
    if (element.value !== element.defaultValue) {
      element.setAttribute("morphlex-dirty", "");
    }
  }
}
function parseFragment(string) {
  const template = document.createElement("template");
  template.innerHTML = string.trim();
  return template.content;
}
function parseDocument(string) {
  const parser = new DOMParser;
  return parser.parseFromString(string.trim(), "text/html");
}
function moveBefore(parent, node, insertionPoint) {
  if (node === insertionPoint)
    return;
  if (node.parentNode === parent) {
    if (node.nextSibling === insertionPoint)
      return;
    if (SUPPORTS_MOVE_BEFORE) {
      parent.moveBefore(node, insertionPoint);
      return;
    }
  }
  parent.insertBefore(node, insertionPoint);
}

class Morph {
  #idArrayMap = new WeakMap;
  #idSetMap = new WeakMap;
  #options;
  constructor(options = {}) {
    this.#options = options;
  }
  morph(from, to) {
    if (isParentNode(from)) {
      this.#mapIdSets(from);
    }
    if (to instanceof NodeList) {
      this.#mapIdArraysForEach(to);
      this.#morphOneToMany(from, to);
    } else if (isParentNode(to)) {
      this.#mapIdArrays(to);
      this.#morphOneToOne(from, to);
    }
  }
  #morphOneToMany(from, to) {
    const length = to.length;
    if (length === 0) {
      this.#removeNode(from);
    } else if (length === 1) {
      this.#morphOneToOne(from, to[0]);
    } else if (length > 1) {
      const newNodes = [...to];
      this.#morphOneToOne(from, newNodes.shift());
      const insertionPoint = from.nextSibling;
      const parent = from.parentNode || document;
      for (let i = 0;i < newNodes.length; i++) {
        const newNode = newNodes[i];
        if (this.#options.beforeNodeAdded?.(parent, newNode, insertionPoint) ?? true) {
          parent.insertBefore(newNode, insertionPoint);
          this.#options.afterNodeAdded?.(newNode);
        }
      }
    }
  }
  #morphOneToOne(from, to) {
    if (from === to)
      return;
    if (from.isEqualNode(to))
      return;
    if (from.nodeType === ELEMENT_NODE_TYPE && to.nodeType === ELEMENT_NODE_TYPE) {
      if (from.localName === to.localName) {
        this.#morphMatchingElements(from, to);
      } else {
        this.#morphNonMatchingElements(from, to);
      }
    } else {
      this.#morphOtherNode(from, to);
    }
  }
  #morphMatchingElements(from, to) {
    if (!(this.#options.beforeNodeVisited?.(from, to) ?? true))
      return;
    if (from.hasAttributes() || to.hasAttributes()) {
      this.#visitAttributes(from, to);
    }
    if (from.localName === "textarea" && to.localName === "textarea") {
      this.#visitTextArea(from, to);
    } else if (from.hasChildNodes() || to.hasChildNodes()) {
      this.visitChildNodes(from, to);
    }
    this.#options.afterNodeVisited?.(from, to);
  }
  #morphNonMatchingElements(from, to) {
    if (!(this.#options.beforeNodeVisited?.(from, to) ?? true))
      return;
    this.#replaceNode(from, to);
    this.#options.afterNodeVisited?.(from, to);
  }
  #morphOtherNode(from, to) {
    if (!(this.#options.beforeNodeVisited?.(from, to) ?? true))
      return;
    if (from.nodeType === to.nodeType && from.nodeValue !== null && to.nodeValue !== null) {
      from.nodeValue = to.nodeValue;
    } else {
      this.#replaceNode(from, to);
    }
    this.#options.afterNodeVisited?.(from, to);
  }
  #visitAttributes(from, to) {
    if (from.hasAttribute("morphlex-dirty")) {
      from.removeAttribute("morphlex-dirty");
    }
    for (const { name, value } of to.attributes) {
      if (name === "value") {
        if (isInputElement(from) && from.value !== value) {
          if (!this.#options.preserveChanges || from.value === from.defaultValue) {
            from.value = value;
          }
        }
      }
      if (name === "selected") {
        if (isOptionElement(from) && !from.selected) {
          if (!this.#options.preserveChanges || from.selected === from.defaultSelected) {
            from.selected = true;
          }
        }
      }
      if (name === "checked") {
        if (isInputElement(from) && !from.checked) {
          if (!this.#options.preserveChanges || from.checked === from.defaultChecked) {
            from.checked = true;
          }
        }
      }
      const oldValue = from.getAttribute(name);
      if (oldValue !== value && (this.#options.beforeAttributeUpdated?.(from, name, value) ?? true)) {
        from.setAttribute(name, value);
        this.#options.afterAttributeUpdated?.(from, name, oldValue);
      }
    }
    for (const { name, value } of from.attributes) {
      if (!to.hasAttribute(name)) {
        if (name === "selected") {
          if (isOptionElement(from) && from.selected) {
            if (!this.#options.preserveChanges || from.selected === from.defaultSelected) {
              from.selected = false;
            }
          }
        }
        if (name === "checked") {
          if (isInputElement(from) && from.checked) {
            if (!this.#options.preserveChanges || from.checked === from.defaultChecked) {
              from.checked = false;
            }
          }
        }
        if (this.#options.beforeAttributeUpdated?.(from, name, null) ?? true) {
          from.removeAttribute(name);
          this.#options.afterAttributeUpdated?.(from, name, value);
        }
      }
    }
  }
  #visitTextArea(from, to) {
    const newTextContent = to.textContent || "";
    const isModified = from.value !== from.defaultValue;
    if (from.textContent !== newTextContent) {
      from.textContent = newTextContent;
    }
    if (this.#options.preserveChanges && isModified)
      return;
    from.value = from.defaultValue;
  }
  visitChildNodes(from, to) {
    if (!(this.#options.beforeChildrenVisited?.(from) ?? true))
      return;
    const parent = from;
    const fromChildNodes = [...from.childNodes];
    const toChildNodes = [...to.childNodes];
    candidateNodes.clear();
    candidateElements.clear();
    candidateElementsWithIds.clear();
    unmatchedNodes.clear();
    unmatchedElements.clear();
    whitespaceNodes.clear();
    const seq = [];
    const matches = [];
    const op = [];
    const nodeTypeMap = [];
    const candidateNodeTypeMap = [];
    const localNameMap = [];
    const candidateLocalNameMap = [];
    for (let i = 0;i < fromChildNodes.length; i++) {
      const candidate = fromChildNodes[i];
      const nodeType = candidate.nodeType;
      candidateNodeTypeMap[i] = nodeType;
      if (nodeType === ELEMENT_NODE_TYPE) {
        candidateLocalNameMap[i] = candidate.localName;
        if (candidate.id !== "") {
          candidateElementsWithIds.add(i);
        } else {
          candidateElements.add(i);
        }
      } else if (nodeType === TEXT_NODE_TYPE && candidate.textContent?.trim() === "") {
        whitespaceNodes.add(i);
      } else {
        candidateNodes.add(i);
      }
    }
    for (let i = 0;i < toChildNodes.length; i++) {
      const node = toChildNodes[i];
      const nodeType = node.nodeType;
      nodeTypeMap[i] = nodeType;
      if (nodeType === ELEMENT_NODE_TYPE) {
        localNameMap[i] = node.localName;
        unmatchedElements.add(i);
      } else if (nodeType === TEXT_NODE_TYPE && node.textContent?.trim() === "") {
        continue;
      } else {
        unmatchedNodes.add(i);
      }
    }
    for (const unmatchedIndex of unmatchedElements) {
      const localName = localNameMap[unmatchedIndex];
      const element = toChildNodes[unmatchedIndex];
      for (const candidateIndex of candidateElements) {
        if (localName !== candidateLocalNameMap[candidateIndex])
          continue;
        const candidate = fromChildNodes[candidateIndex];
        if (candidate.isEqualNode(element)) {
          matches[unmatchedIndex] = candidateIndex;
          op[unmatchedIndex] = Operation.EqualNode;
          seq[candidateIndex] = unmatchedIndex;
          candidateElements.delete(candidateIndex);
          unmatchedElements.delete(unmatchedIndex);
          break;
        }
      }
    }
    for (const unmatchedIndex of unmatchedElements) {
      const element = toChildNodes[unmatchedIndex];
      const id = element.id;
      const idArray = this.#idArrayMap.get(element);
      if (id === "" && !idArray)
        continue;
      candidateLoop:
        for (const candidateIndex of candidateElementsWithIds) {
          const candidate = fromChildNodes[candidateIndex];
          if (localNameMap[unmatchedIndex] === candidateLocalNameMap[candidateIndex]) {
            if (id !== "" && id === candidate.id) {
              matches[unmatchedIndex] = candidateIndex;
              op[unmatchedIndex] = Operation.SameElement;
              seq[candidateIndex] = unmatchedIndex;
              candidateElementsWithIds.delete(candidateIndex);
              unmatchedElements.delete(unmatchedIndex);
              break candidateLoop;
            }
            if (idArray) {
              const candidateIdSet = this.#idSetMap.get(candidate);
              if (candidateIdSet) {
                for (let i = 0;i < idArray.length; i++) {
                  const arrayId = idArray[i];
                  if (candidateIdSet.has(arrayId)) {
                    matches[unmatchedIndex] = candidateIndex;
                    op[unmatchedIndex] = Operation.SameElement;
                    seq[candidateIndex] = unmatchedIndex;
                    candidateElementsWithIds.delete(candidateIndex);
                    unmatchedElements.delete(unmatchedIndex);
                    break candidateLoop;
                  }
                }
              }
            }
          }
        }
    }
    for (const unmatchedIndex of unmatchedElements) {
      const element = toChildNodes[unmatchedIndex];
      const name = element.getAttribute("name");
      const href = element.getAttribute("href");
      const src = element.getAttribute("src");
      for (const candidateIndex of candidateElements) {
        const candidate = fromChildNodes[candidateIndex];
        if (localNameMap[unmatchedIndex] === candidateLocalNameMap[candidateIndex] && (name && name === candidate.getAttribute("name") || href && href === candidate.getAttribute("href") || src && src === candidate.getAttribute("src"))) {
          matches[unmatchedIndex] = candidateIndex;
          seq[candidateIndex] = unmatchedIndex;
          op[unmatchedIndex] = Operation.SameElement;
          candidateElements.delete(candidateIndex);
          unmatchedElements.delete(unmatchedIndex);
          break;
        }
      }
    }
    for (const unmatchedIndex of unmatchedElements) {
      const element = toChildNodes[unmatchedIndex];
      const localName = localNameMap[unmatchedIndex];
      for (const candidateIndex of candidateElements) {
        const candidate = fromChildNodes[candidateIndex];
        const candidateLocalName = candidateLocalNameMap[candidateIndex];
        if (localName === candidateLocalName) {
          if (localName === "input" && candidate.type !== element.type) {
            continue;
          }
          matches[unmatchedIndex] = candidateIndex;
          seq[candidateIndex] = unmatchedIndex;
          op[unmatchedIndex] = Operation.SameElement;
          candidateElements.delete(candidateIndex);
          unmatchedElements.delete(unmatchedIndex);
          break;
        }
      }
    }
    for (const unmatchedIndex of unmatchedNodes) {
      const node = toChildNodes[unmatchedIndex];
      for (const candidateIndex of candidateNodes) {
        const candidate = fromChildNodes[candidateIndex];
        if (candidate.isEqualNode(node)) {
          matches[unmatchedIndex] = candidateIndex;
          op[unmatchedIndex] = Operation.EqualNode;
          seq[candidateIndex] = unmatchedIndex;
          candidateNodes.delete(candidateIndex);
          unmatchedNodes.delete(unmatchedIndex);
          break;
        }
      }
    }
    for (const unmatchedIndex of unmatchedNodes) {
      const nodeType = nodeTypeMap[unmatchedIndex];
      for (const candidateIndex of candidateNodes) {
        if (nodeType === candidateNodeTypeMap[candidateIndex]) {
          matches[unmatchedIndex] = candidateIndex;
          op[unmatchedIndex] = Operation.SameNode;
          seq[candidateIndex] = unmatchedIndex;
          candidateNodes.delete(candidateIndex);
          unmatchedNodes.delete(unmatchedIndex);
          break;
        }
      }
    }
    for (const i of candidateNodes)
      this.#removeNode(fromChildNodes[i]);
    for (const i of whitespaceNodes)
      this.#removeNode(fromChildNodes[i]);
    for (const i of candidateElements)
      this.#removeNode(fromChildNodes[i]);
    for (const i of candidateElementsWithIds)
      this.#removeNode(fromChildNodes[i]);
    const lisIndices = longestIncreasingSubsequence(matches);
    const shouldNotMove = new Array(fromChildNodes.length);
    for (let i = 0;i < lisIndices.length; i++) {
      shouldNotMove[matches[lisIndices[i]]] = true;
    }
    let insertionPoint = parent.firstChild;
    for (let i = 0;i < toChildNodes.length; i++) {
      const node = toChildNodes[i];
      const matchInd = matches[i];
      if (matchInd !== undefined) {
        const match = fromChildNodes[matchInd];
        const operation = op[i];
        if (!shouldNotMove[matchInd]) {
          moveBefore(parent, match, insertionPoint);
        }
        if (operation === Operation.EqualNode) {} else if (operation === Operation.SameElement) {
          this.#morphMatchingElements(match, node);
        } else {
          this.#morphOneToOne(match, node);
        }
        insertionPoint = match.nextSibling;
      } else {
        if (this.#options.beforeNodeAdded?.(parent, node, insertionPoint) ?? true) {
          parent.insertBefore(node, insertionPoint);
          this.#options.afterNodeAdded?.(node);
          insertionPoint = node.nextSibling;
        }
      }
    }
    this.#options.afterChildrenVisited?.(from);
  }
  #replaceNode(node, newNode) {
    const parent = node.parentNode || document;
    const insertionPoint = node;
    if ((this.#options.beforeNodeRemoved?.(node) ?? true) && (this.#options.beforeNodeAdded?.(parent, newNode, insertionPoint) ?? true)) {
      parent.insertBefore(newNode, insertionPoint);
      this.#options.afterNodeAdded?.(newNode);
      node.remove();
      this.#options.afterNodeRemoved?.(node);
    }
  }
  #removeNode(node) {
    if (this.#options.beforeNodeRemoved?.(node) ?? true) {
      node.remove();
      this.#options.afterNodeRemoved?.(node);
    }
  }
  #mapIdArraysForEach(nodeList) {
    for (const childNode of nodeList) {
      if (isParentNode(childNode)) {
        this.#mapIdArrays(childNode);
      }
    }
  }
  #mapIdArrays(node) {
    const idArrayMap = this.#idArrayMap;
    for (const element of node.querySelectorAll("[id]")) {
      const id = element.id;
      if (id === "")
        continue;
      let currentElement = element;
      while (currentElement) {
        const idArray = idArrayMap.get(currentElement);
        if (idArray) {
          idArray.push(id);
        } else {
          idArrayMap.set(currentElement, [id]);
        }
        if (currentElement === node)
          break;
        currentElement = currentElement.parentElement;
      }
    }
  }
  #mapIdSets(node) {
    const idSetMap = this.#idSetMap;
    for (const element of node.querySelectorAll("[id]")) {
      const id = element.id;
      if (id === "")
        continue;
      let currentElement = element;
      while (currentElement) {
        const idSet = idSetMap.get(currentElement);
        if (idSet) {
          idSet.add(id);
        } else {
          idSetMap.set(currentElement, new Set([id]));
        }
        if (currentElement === node)
          break;
        currentElement = currentElement.parentElement;
      }
    }
  }
}
function isInputElement(element) {
  return element.localName === "input";
}
function isOptionElement(element) {
  return element.localName === "option";
}
function isParentNode(node) {
  return !!IS_PARENT_NODE_TYPE[node.nodeType];
}
function longestIncreasingSubsequence(sequence) {
  const n = sequence.length;
  if (n === 0)
    return [];
  const smallestEnding = [];
  const indices = [];
  const prev = new Array(n);
  for (let i = 0;i < n; i++) {
    const val = sequence[i];
    if (val === undefined)
      continue;
    let left = 0;
    let right = smallestEnding.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (smallestEnding[mid] < val)
        left = mid + 1;
      else
        right = mid;
    }
    prev[i] = left > 0 ? indices[left - 1] : -1;
    if (left === smallestEnding.length) {
      smallestEnding.push(val);
      indices.push(i);
    } else {
      smallestEnding[left] = val;
      indices[left] = i;
    }
  }
  const result = [];
  if (indices.length === 0)
    return result;
  let curr = indices[indices.length - 1];
  while (curr !== undefined && curr !== -1) {
    result.unshift(curr);
    curr = prev[curr];
  }
  return result;
}
export {
  morphInner,
  morphDocument,
  morph
};

//# debugId=3F4BCB911DEC843864756E2164756E21
