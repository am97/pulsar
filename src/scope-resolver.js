const { Point } = require('text-buffer');

// TODO: These utility functions are duplicated between this file and
// `wasm-tree-sitter-language-mode.js`. Eventually they might need to be moved
// into a `utils` file somewhere.

// Compares “informal” points like the ones in a tree-sitter tree; saves us
// from having to convert them to actual `Point`s.
function comparePoints(a, b) {
  const rows = a.row - b.row;
  if (rows === 0) {
    return a.column - b.column
  } else {
    return rows;
  }
}

function isBetweenPoints (point, a, b) {
  let comp = comparePoints(a, b);
  let lesser = comp > 0 ? b : a;
  let greater = comp > 0 ? a : b;
  return comparePoints(point, lesser) >= 0 &&
    comparePoints(point, greater) <= 0;
}

function resolveNodeDescriptor (node, descriptor) {
  let parts = descriptor.split('.');
  let result = node;
  while (result !== null && parts.length > 0) {
    let part = parts.shift();
    if (!result[part]) { return null; }
    result = result[part];
  }
  return result;
}

function resolveNodePosition (node, descriptor) {
  let parts = descriptor.split('.');
  let lastPart = parts.pop();
  let result = parts.length === 0 ?
    node :
    resolveNodeDescriptor(node, parts.join('.'));

  return result[lastPart];
}

// A data structure for storing scope information while processing capture
// data. The data is reset in between each task.
//
// It also applies the conventions that we've adopted in SCM files
// (particularly in `highlights.scm`) that let us constrain the conditions
// under which various scopes get applied. When a given query capture is added,
// `ScopeResolver` may "reject" it if it fails to pass the given test.
//
// `ScopeResolver` also sets boundaries for possible consumption by a
// `HighlightIterator`. However, it is used to resolve several different kinds
// of query captures — not just highlights.
class ScopeResolver {
  constructor(languageLayer, idForScope) {
    this.languageLayer = languageLayer;
    this.buffer = languageLayer.buffer;
    this.idForScope = idForScope ?? (x => x);
    this.map = new Map;
    this.rangeData = new Map;
    this.patternCache = new Map;
  }

  getOrCompilePattern(pattern) {
    let regex = this.patternCache.get(pattern);
    if (!regex) {
      regex = new RegExp(pattern);
      this.patternCache.set(pattern, regex);
    }
    return regex;
  }

  indexToPosition(index) {
    return this.buffer.positionForCharacterIndex(index);
  }

  positionToIndex(position)  {
    return this.buffer.characterIndexForPosition(position);
  }

  adjustPositionByOffset(position, offset) {
    let index = this.positionToIndex(position);
    index += offset;
    let newPosition = this.indexToPosition(index);
    return this.buffer.clipPosition(newPosition);
  }

  _keyForPoint(point) {
    return `${point.row},${point.column}`
  }

  _keyForRange(range) {
    let { startIndex, endIndex } = range;
    return `${startIndex}/${endIndex}`;
  }

  _keyToObject(key) {
    let [row, column] = key.split(',');
    return new Point(Number(row), Number(column));
  }

  setDataForRange(range, props) {
    let key = this._keyForRange(range);
    return this.rangeData.set(key, props);
  }

  getDataForRange(syntax) {
    let key = this._keyForRange(syntax);
    return this.rangeData.get(key);
  }

  isValidRange(range) {
    let { startPosition, startIndex, endPosition, endIndex } = range;
    if (!(
      typeof startIndex === 'number' &&
      typeof endIndex === 'number' &&
      typeof startPosition === 'object' &&
      typeof endPosition === 'object'
    )) { return false; }
    if (startIndex > endIndex) { return false; }
    if (comparePoints(startPosition, endPosition) >= 0) { return false; }
    return true;
  }

  // Detects whether a capture wants to alter its range from the default.
  adjustsCaptureRange(capture) {
    let { setProperties: props = {} } = capture;
    let keys = Object.keys(props);
    if (keys.length === 0) { return false; }
    return keys.some(k => k in ScopeResolver.ADJUSTMENTS);
  }

  // Given a capture and possible predicate data, determines the buffer range
  // that this capture wants to cover.
  determineCaptureRange(capture) {
    // For our purposes, a "range" is not a `Range` object, but rather an
    // object that has all four of `startPosition`, `endPosition`,
    // `startIndex`, and `endIndex`. Any single node can thus fulfill this
    // contract, but so can a plain object of our own construction.
    let { setProperties: props = {} } = capture;
    if (!this.adjustsCaptureRange(capture)) { return capture.node; }

    let range = {
      startPosition: capture.node.startPosition,
      startIndex: capture.node.startIndex,
      endPosition: capture.node.endPosition,
      endIndex: capture.node.endIndex
    };

    for (let key in props) {
      if (key in ScopeResolver.ADJUSTMENTS) {
        let value = props[key];

        // Transform the range successively. Later adjustments can optionally
        // act on earlier adjustments, or they can ignore the current position
        // and inspect the original node instead.
        range = ScopeResolver.ADJUSTMENTS[key](
          capture.node, value, props, range, this);

        // If any single adjustment returns `null`, we shouldn't store this
        // capture.
        if (range === null) { return null; }
      }
    }

    // Any invalidity in the returned range means we shouldn't store this
    // capture.
    if (!this.isValidRange(range)) { return null; }
    return range;
  }

  // Given a syntax capture, test whether we should include its scope in the
  // document.
  test(existingData, props, node) {
    if (existingData?.final) { return false; }

    for (let key in props) {
      if (!(key in ScopeResolver.TESTS)) { continue; }
      let test = ScopeResolver.TESTS[key];
      let value = props[key];
      if (!test(node, value, props, existingData, this)) {
        return false;
      }
    }
    return true;
  }

  // Attempt to add a syntax capture to the boundary data, along with its scope
  // ID. Will apply any adjustments to determine the range of the scope being
  // applied, then check any test rules to see whether the scope should be
  // added for that range.
  //
  // Will return `false` if the scope should not be added for the given range;
  // otherwise will return the computed range.
  store(syntax) {
    let {
      node,
      name,
      setProperties: props = {}
    } = syntax;

    name = ScopeResolver.interpolateName(name, node);

    // Find out which range this capture wants.
    let range = this.determineCaptureRange(syntax);
    if (range === null) {
      // This capture specified a range adjustment that turned out not to be
      // valid. We view those adjustments as essential — that is, if the
      // assumed conditions of the `#set!` rules result in invalidity, it means
      // that we should not try to honor the capture in the first place.
      return false;
    }

    let data = this.getDataForRange(range);

    if (!this.test(data, props, node, name)) {
      return false;
    } else {
      this.setDataForRange(range, props);
    }

    if (name === '_IGNORE_') {
      // "@_IGNORE_" is a magical variable in an SCM file that will not be
      // applied in the grammar, but allows us to prevent other kinds of scopes
      // from matching. We purposefully allowed this syntax node to set data
      // for a given range, but not to apply its scope ID to any boundaries.
      return false;
    }

    let id = this.idForScope(name);

    let {
      startPosition: start,
      endPosition: end
    } = range;

    this.setBoundary(start, id, 'open');
    this.setBoundary(end, id, 'close');

    return range;
  }

  setBoundary(point, id, which, { root = false } = {}) {
    let key = this._keyForPoint(point);

    if (!this.map.has(key)) {
      this.map.set(key, { open: [], close: [] })
    }

    let bundle = this.map.get(key);
    let idBundle = bundle[which];

    // In general, we want to close scopes in the reverse order of when they
    // were opened, and captures that match earlier get to open first. But
    // `root` is a way of opting out of this behavior and asserting that a
    // scope added later is more important. We use this to add the language's
    // root scope if needed.
    if (which === 'open') {
      // If an earlier token has already opened at this point, we want to open
      // after it.
      if (root) { idBundle.unshift(id); }
      else { idBundle.push(id); }
    } else {
      // If an earlier token has already closed at this point, we want to close
      // before it.
      if (root) { idBundle.push(id); }
      else { idBundle.unshift(id); }
    }
  }

  reset() {
    this.map.clear();
    this.rangeData.clear();
  }

  *[Symbol.iterator] () {
    // The ordering of the keys doesn't matter here because we'll be putting
    // them into a red-black tree that will be responsible for ordering the
    // boundaries.
    for (let key of this.map.keys()) {
      let point = this._keyToObject(key);
      yield [point, this.map.get(key)];
    }
  }
}


// Scope names can mark themselves with `TEXT` to interpolate the node's text
// into the capture, or `TYPE` to interpolate the anonymous node's type.
ScopeResolver.interpolateName = (name, node) => {
  // Only interpolate `_TEXT_` if we know the text has no spaces. Spaces are
  // not valid in scope names.
  if (name.includes('_TEXT_') &&
   !node.text.includes(' ')) {
    name = name.replace('_TEXT_', node.text);
  }
  name = name.replace('_TYPE_', node.type);
  return name;
};

// These tests are used to define criteria under which the scope should be
// applied. Set them in a query file like so:
//
// (
//   (foo) @some.scope.name
//   (#set! onlyIfFirst true)
// )
//
// For boolean rules, the second argument to `#set!` is arbitrary, but must be
// something truthy; `true` is suggested.
//
// These tests come in handy for criteria that can't be represented by the
// built-in predicates like `#match?` and `#eq?`.
//
// NOTE: Syntax queries will always be run through a `ScopeResolver`, but other
// kinds of queries may or may not, depending on purpse.
//
ScopeResolver.TESTS = {
  // Passes only if another node has not already declared `final` for the exact
  // same range. If a capture is the first one to define `final`, then all
  // other captures for that same range are ignored, whether they try to define
  // `final` or not.
  final (node, value, props, existingData) {
    return !(existingData && existingData.final);
  },

  // Passes only if no earlier capture has occurred for the exact same range.
  shy (node, value, props, existingData) {
    return existingData === undefined;
  },

  // Passes only if this is an ERROR node.
  onlyIfError(node) {
    return node.type === 'ERROR';
  },

  onlyIfHasError(node) {
    return node.hasError();
  },

  // Passes when the node is part of a tree that belongs to an injection layer.
  onlyIfInjection(node, value, props, existingData, instance) {
    return instance.languageLayer.depth > 0;
  },

  // Passes when the node has no parent.
  onlyIfRoot(node) {
    return !node.parent;
  },

  // Passes only if the given node is the first among its siblings.
  onlyIfFirst(node) {
    if (!node.parent) {
      // Root nodes are always first.
      return true;
    }
    // We're really paranoid on these because if the parse tree is in an error
    // state, weird things can happen, like a node's parent not having a
    // `firstChild`.
    return node?.parent?.firstChild?.id === node.id;
  },

  // Passes only if the given node is not the first among its siblings.
  onlyIfNotFirst(node) {
    if (!node.parent) { return false; }

    return node?.parent?.firstChild?.id !== node.id;
  },

  // Passes only if the given node is the last among its siblings.
  onlyIfLast (node) {
    if (!node.parent) {
      // Root nodes are always last.
      return true;
    }
    return node?.parent?.lastChild?.id === node.id;
  },

  // Passes only if the given node is not the last among its siblings.
  onlyIfNotLast (node) {
    if (!node.parent) { return false; }

    return node?.parent?.lastChild?.id !== node.id;
  },

  // Passes when the node is the first of its type among its siblings.
  onlyIfFirstOfType(node) {
    if (!node.parent) { return true; }
    let type = node.type;
    let parent = node.parent;
    for (let i = 0; i < parent.childCount; i++) {
      let child = parent.child(i);
      if (child.id === node.id) { return true; }
      else if (child.type === type) { return false; }
    }
    return false;
  },

  // Passes when the node is the last of its type among its siblings.
  onlyIfLastOfType(node) {
    if (!node.parent) { return true; }
    let type = node.type;
    let parent = node.parent;
    for (let i = parent.childCount - 1; i >= 0; i--) {
      let child = parent.child(i);
      if (child.id === node.id) { return true; }
      else if (child.type === type) { return false; }
    }
  },

  // Passes when the node represents the last non-whitespace content on its row.
  onlyIfLastTextOnRow(node, value, props, existingData, instance) {
    let { buffer } = instance;
    let text = buffer.lineForRow(node.endPosition.row);
    let textAfterNode = text.slice(node.endPosition.column);
    return !/\S/.test(textAfterNode);
  },

  // Passes when the node is not the last non-whitespace content on its row.
  onlyIfNotLastTextOnRow(...args) {
    let isLastTextOnRow = ScopeResolver.TESTS.onlyIfLastTextOnRow(...args);
    return !isLastTextOnRow;
  },

  // Passes if this node has a node of the given type in its ancestor chain.
  onlyIfDescendantOfType(node, type) {
    let current = node;
    while (current.parent) {
      current = current.parent;
      if (current.type === type) { return true; }
    }
    return false;
  },

  // Passes if this node does not have a node of the given type in its ancestor
  // chain.
  onlyIfNotDescendantOfType(...args) {
    let isDescendantOfType = ScopeResolver.TESTS.onlyIfDescendantOfType(...args);
    return !isDescendantOfType;
  },

  // Passes if this node has at least one descendant of the given type.
  onlyIfAncestorOfType(node, type) {
    let descendants = node.descendantsOfType(type);
    return descendants.length > 0;
  },

  // Passes if this node has zero descendants of the given type.
  onlyIfNotAncestorOfType(node, type) {
    let descendants = node.descendantsOfType(type);
    return descendants.length === 0;
  },

  // Passes if one of this node's ancestors has stored data at a given key.
  onlyIfDescendantOfNodeWithData(node, key, props, existingData, instance) {
    let current = node;
    while (current.parent) {
      current = current.parent;
      let data = instance.getDataForRange(current);
      if (data === undefined) { continue; }
      if (key in data) return true;
    }
    return false;
  },

  // Passes if none of this node's ancestors has stored data at a given key.
  onlyIfNotDescendantOfNodeWithData(...args) {
    let isDescendantOfNodeWithData = ScopeResolver.TESTS.onlyIfDescendantOfNodeWithData(...args);
    return !isDescendantOfNodeWithData;
  },

  // Passes if this node starts on the same row as the one in the described
  // position.
  onlyIfOnSameRowAs(node, descriptor) {
    let otherNodePosition = resolveNodePosition(node, descriptor);
    return otherNodePosition.row === node.startPosition.row;
  },

  // Passes if this node starts on a different row than the one in the
  // described position.
  onlyIfNotOnSameRowAs(node, descriptor) {
    let otherNodePosition = resolveNodePosition(node, descriptor);
    return otherNodePosition.row !== node.startPosition.row;
  }
};

// Usually, we want to map a scope to the exact range of a node in the tree,
// but sometimes that isn't possible. "Adjustments" are pieces of metadata
// assigned to captures that can transform the range to a subset of
// the initial range.
//
// Adjustments cannot
ScopeResolver.ADJUSTMENTS = {
  // Alter the given range to start at the start or end of a different node.
  startAt(node, value, props, range, resolver) {
    let start = resolveNodePosition(node, value);
    if (!isBetweenPoints(start, node.startPosition, node.endPosition)) {
      throw new Error('Cannot extend past original range of capture');
    }
    range.startPosition = start;
    range.startIndex = resolver.positionToIndex(range.startPosition);
    return range;
  },

  // Alter the given range to end at the start or end of a different node.
  endAt (node, value, props, range, resolver) {
    let end = resolveNodePosition(node, value);
    if (!isBetweenPoints(end, node.startPosition, node.endPosition)) {
      throw new Error('Cannot extend past original range of capture');
    }
    range.endPosition = end;
    range.endIndex = resolver.positionToIndex(range.endPosition);
    return range;
  },

  // Offset the start position by a fixed number of characters in either
  // direction. Can act after other range alterations.
  offsetStart(node, value, props, range, resolver) {
    let offset = Number(value);
    if (isNaN(offset)) { return null; }
    let { startPosition } = range;

    let offsetPosition = resolver.adjustPositionByOffset(startPosition, offset);
    let offsetIndex = resolver.positionToIndex(offsetPosition);

    if (!isBetweenPoints(offsetPosition, node.startPosition, node.endPosition)) {
      throw new Error('Cannot extend past original range of capture');
    }

    range.startPosition = offsetPosition;
    range.startIndex = offsetIndex;

    return range;
  },

  // Offset the end position by a fixed number of characters in either
  // direction. Can act after other range alterations.
  offsetEnd(node, value, props, range, resolver) {
    let offset = Number(value);
    if (isNaN(offset)) { return null; }
    let { endPosition } = range;

    let offsetPosition = resolver.adjustPositionByOffset(endPosition, offset);
    let offsetIndex = resolver.positionToIndex(offsetPosition);

    if (!isBetweenPoints(offsetPosition, node.startPosition, node.endPosition)) {
      throw new Error('Cannot extend past original range of capture');
    }

    range.endPosition = offsetPosition;
    range.endIndex = offsetIndex;

    return range;
  },

  // Change the start and end positions to correspond exactly to the extent of
  // the match of the given regular expression. Will match against the text of
  // the capture's node.
  startAndEndAroundFirstMatchOf(node, value, props, position, resolver) {
    let regex = resolver.getOrCompilePattern(value);
    let match = node.text.match(regex);
    if (!match) { return null; }
    let oldStartPosition = { ...node.startPosition };
    let startOffset = match.index;
    let endOffset = match.index + match[0].length;

    position.startPosition = resolver.adjustPositionByOffset(
      oldStartPosition, startOffset);
    position.endPosition = resolver.adjustPositionByOffset(
      oldStartPosition, endOffset);

    position.startIndex = resolver.positionToIndex(position.startPosition);
    position.endIndex = resolver.positionToIndex(position.endPosition);

    return position;
  },

  // Change the start position to the point at the beginning of the match of
  // the given regular expression. Will match against the text of the capture's
  // node.
  startBeforeFirstMatchOf(node, value, props, position, resolver) {
    let regex = resolver.getOrCompilePattern(value);
    let match = node.text.match(regex);

    if (!match) { return null; }
    let oldStartPosition = { ...node.startPosition };

    let startOffset = match.index;

    position.startPosition = resolver.adjustPositionByOffset(
      oldStartPosition, startOffset);
    position.startIndex = resolver.positionToIndex(position.startPosition);

    return position;
  },

  // Change the start position to the point at the end of the match of the
  // given regular expression. Will match against the text of the capture's
  // node.
  startAfterFirstMatchOf(node, value, props, position, resolver) {
    let regex = resolver.getOrCompilePattern(value);
    let match = node.text.match(regex);

    if (!match) { return null; }
    let oldStartPosition = { ...node.startPosition };

    let startOffset = match.index + match[0].length;

    position.startPosition = resolver.adjustPositionByOffset(
      oldStartPosition, startOffset);
    position.startIndex = resolver.positionToIndex(position.startPosition);

    return position;
  },

  // Change the end position to the point at the start of the match of the
  // given regular expression. Will match against the text of the capture's
  // node.
  endBeforeFirstMatchOf(node, value, props, position, resolver) {
    let regex = resolver.getOrCompilePattern(value);
    let match = node.text.match(regex);

    if (!match) { return null; }
    let oldStartPosition = { ...node.startPosition };
    let endOffset = match.index;

    position.endPosition = resolver.adjustPositionByOffset(
      oldStartPosition, endOffset);
    position.endIndex = resolver.positionToIndex(position.endPosition);

    return position;
  },

  // Change the end position to the point at the end of the match of the
  // given regular expression. Will match against the text of the capture's
  // node.
  endAfterFirstMatchOf(node, value, props, position, resolver) {
    let regex = resolver.getOrCompilePattern(value);
    let match = node.text.match(regex);

    if (!match) { return null; }
    let oldStartPosition = { ...node.startPosition };
    let endOffset = match.index + match[0].length;

    position.endPosition = resolver.adjustPositionByOffset(
      oldStartPosition, endOffset);
    position.endIndex = resolver.positionToIndex(position.endPosition);

    return position;
  }
};


module.exports = ScopeResolver;
