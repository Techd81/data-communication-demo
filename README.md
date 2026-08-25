# 数据通信网络 · 智能全流程演示系统

基于发明专利《一种数据通信网络的数据通信方法及系统》构建的高交互网页演示系统，
完整覆盖权利要求 1-10 的全部技术特征，所有算法均可真实运行。

## 特性

- **纯前端原生实现，零依赖**：HTML5 + CSS3 + Canvas + Web Crypto API
- **真实可运行的核心算法**：
  - Huffman 编码 / 解码（频次表重建前缀树）
  - RS 纠删码（GF(256) 有限域，系统化编码 + 擦除恢复伴随式方程求解）
  - AES-128-GCM 加解密（SHA-256 派生动态密钥 K = H(I, S, T)）
- **自适应编码决策**：根据实时网络参数切换编码方案
  - 带宽 B ≥ 8 Mbps 且丢包率 L ≤ 5% → Huffman 高效编码
  - 否则 → RS 容错编码（冗余符号 n_r 可调）
- **全流程覆盖**：动态密钥派生 → AES 加密 → 分块 → 多路径传输 → 丢包重传 →
  完整性校验 → 排序重组 → 解密还原
- **Hand-Drawn Sketch 手绘涂鸦风格**：纸面点阵背景、粉彩便签卡片、手写笔迹与弹性动效
- **响应式布局**：桌面 / 平板 / 移动端自适应

## 快速开始

无需构建工具，任意静态服务器即可运行：

```bash
cd 演示系统
python -m http.server 8747 --bind 127.0.0.1
# 浏览器访问 http://127.0.0.1:8747/index.html
```

也可直接双击 `演示系统/index.html` 以 `file://` 协议打开
（Chrome / Edge / Firefox 对本地文件均视为 Web Crypto 安全上下文）。

## 目录结构

```
├── 演示系统/         交互式演示系统（核心代码）
│   ├── index.html    页面骨架（八大全流程板块 + 手绘 SVG 滤镜）
│   ├── css/          手绘涂鸦风格样式
│   └── js/
│       ├── huffman.js  Huffman 编码/解码
│       ├── rscode.js   RS 纠删码（GF(256)）
│       ├── engine.js   演示引擎（全流程状态机 + 日志）
│       ├── viz.js      Canvas 多路径传输可视化
│       └── app.js      UI 交互层
├── README.md
└── LICENSE
```

详细说明（页面结构、操作指南、风格规范、算法验证）见
[演示系统/README.md](演示系统/README.md)。

## 许可证

本仓库以 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
许可证发布：允许个人学习、研究与展示等非商业用途，禁止商业使用。
完整条款见 [LICENSE](LICENSE)。
