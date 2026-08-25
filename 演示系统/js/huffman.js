/* ============================================================
 * Huffman 编码 / 解码  —— 自适应编码·高效模式
 * 真实实现：频次统计 → 哈夫曼树 → 前缀码 → 比特打包
 * ============================================================ */
(function (global) {
  'use strict';

  /**
   * 构建哈夫曼树并生成编码表
   * @param {Uint8Array} data
   * @returns {{codeTable: Map<number,string>, freq: Uint8Array, root: object}}
   */
  function buildHuffman(data) {
    const freq = new Uint32Array(256);
    for (let i = 0; i < data.length; i++) freq[data[i]]++;

    // 节点池（森林）
    let nodes = [];
    for (let b = 0; b < 256; b++) {
      if (freq[b] > 0) nodes.push({ sym: b, freq: freq[b], l: null, r: null });
    }

    // 单符号兜底：给唯一符号补一个哨兵，避免空编码
    if (nodes.length === 1) {
      const only = nodes[0];
      nodes.push({ sym: -1, freq: 0, l: null, r: null });
    }

    // 最小堆（每次取两个最小）
    const sortFn = (a, b) => a.freq - b.freq;
    while (nodes.length > 1) {
      nodes.sort(sortFn);
      const l = nodes.shift();
      const r = nodes.shift();
      nodes.push({ sym: -1, freq: l.freq + r.freq, l, r });
    }
    const root = nodes[0];

    // 生成前缀码
    const codeTable = new Map();
    const stack = [{ node: root, code: '' }];
    while (stack.length) {
      const { node, code } = stack.pop();
      if (node.sym !== -1 && node.l === null) {
        codeTable.set(node.sym, code.length ? code : '0');
        continue;
      }
      if (node.l) stack.push({ node: node.l, code: code + '0' });
      if (node.r) stack.push({ node: node.r, code: code + '1' });
    }
    return { codeTable, freq: new Uint8Array(freq), root };
  }

  /**
   * Huffman 编码
   * @param {Uint8Array} data
   * @returns {{encoded: Uint8Array, codeTable: Map, freq: Uint8Array, bitLen: number}}
   */
  function huffmanEncode(data) {
    const { codeTable, freq } = buildHuffman(data);
    let bitLen = 0;
    for (let i = 0; i < data.length; i++) bitLen += codeTable.get(data[i]).length;

    // 比特打包
    const out = new Uint8Array(Math.ceil(bitLen / 8));
    let bitPos = 0;
    for (let i = 0; i < data.length; i++) {
      const code = codeTable.get(data[i]);
      for (let b = 0; b < code.length; b++) {
        if (code[b] === '1') out[bitPos >> 3] |= 0x80 >> (bitPos & 7);
        bitPos++;
      }
    }
    return { encoded: out, codeTable, freq, bitLen };
  }

  /**
   * Huffman 解码（利用频次表重建树）
   * @param {Uint8Array} encoded
   * @param {number} bitLen 原始比特长度
   * @param {Uint8Array} freq 频次表（256 项）
   * @returns {Uint8Array}
   */
  function huffmanDecode(encoded, bitLen, freq) {
    // 重建森林
    let nodes = [];
    for (let b = 0; b < 256; b++) {
      if (freq[b] > 0) nodes.push({ sym: b, freq: freq[b], l: null, r: null });
    }
    if (nodes.length === 1) nodes.push({ sym: -1, freq: 0, l: null, r: null });
    const sortFn = (a, b) => a.freq - b.freq;
    while (nodes.length > 1) {
      nodes.sort(sortFn);
      const l = nodes.shift(), r = nodes.shift();
      nodes.push({ sym: -1, freq: l.freq + r.freq, l, r });
    }
    const root = nodes[0];
    if (!root) return new Uint8Array(0);

    // 逐位游走
    const out = [];
    let node = root;
    for (let pos = 0; pos < bitLen; pos++) {
      const bit = (encoded[pos >> 3] >> (7 - (pos & 7))) & 1;
      node = bit ? node.r : node.l;
      if (node && node.sym !== -1 && node.l === null) {
        out.push(node.sym);
        node = root;
      }
      if (!node) { node = root; } // 防御：损坏数据
    }
    return new Uint8Array(out);
  }

  global.Huffman = { encode: huffmanEncode, decode: huffmanDecode };
})(window);
