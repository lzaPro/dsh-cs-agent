#!/usr/bin/env bash
# 编译 macOS Vision OCR 二进制（仅 macOS 需要；Linux/Windows 用 tesseract）
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tools/bin" "$ROOT/.build/swift-modules" "$ROOT/.build/tmp"
TMPDIR="$ROOT/.build/tmp" swiftc -O \
  -module-cache-path "$ROOT/.build/swift-modules" \
  "$ROOT/tools/ocr.swift" -o "$ROOT/tools/bin/ocr"
echo "built $ROOT/tools/bin/ocr"
