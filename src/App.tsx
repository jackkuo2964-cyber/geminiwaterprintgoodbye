看了一下程式碼，問題很清楚：`WatermarkSelector` 元件只有 `onMouseDown/Move/Up` 事件，完全沒有 touch 事件支援，所以手機上無法操作。

需要補上 `onTouchStart`、`onTouchMove`、`onTouchEnd`，並從 `touches[0]` 取得座標。以下是修正後的 `WatermarkSelector` 元件：

```tsx
const WatermarkSelector = ({ 
  image, 
  onConfirm, 
  onCancel 
}: { 
  image: ProcessedImage; 
  onConfirm: (config: WatermarkConfig) => void; 
  onCancel: () => void; 
}) => {
  const [startPos, setStartPos] = useState<{x: number, y: number} | null>(null);
  const [currentPos, setCurrentPos] = useState<{x: number, y: number} | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 統一取得相對座標的 helper（滑鼠 & 觸控都用這個）
  const getRelativePos = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(clientY - rect.top, rect.height)),
    };
  };

  // --- Mouse handlers ---
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const pos = getRelativePos(e.clientX, e.clientY);
    if (!pos) return;
    setStartPos(pos);
    setCurrentPos(pos);
    setIsDrawing(true);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing) return;
    const pos = getRelativePos(e.clientX, e.clientY);
    if (pos) setCurrentPos(pos);
  };

  const handleMouseUp = async () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    await runAutoDetect();
  };

  // --- Touch handlers ---
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    e.preventDefault(); // 防止頁面捲動
    const touch = e.touches[0];
    const pos = getRelativePos(touch.clientX, touch.clientY);
    if (!pos) return;
    setStartPos(pos);
    setCurrentPos(pos);
    setIsDrawing(true);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isDrawing) return;
    const touch = e.touches[0];
    const pos = getRelativePos(touch.clientX, touch.clientY);
    if (pos) setCurrentPos(pos);
  };

  const handleTouchEnd = async (e: React.TouchEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isDrawing) return;
    setIsDrawing(false);
    await runAutoDetect();
  };

  // --- 自動偵測邏輯（抽出共用，mouse/touch 都呼叫） ---
  const runAutoDetect = async () => {
    if (!startPos || !currentPos || !imgRef.current || !image.width || !image.height) return;
    if (Math.abs(currentPos.x - startPos.x) < 20 || Math.abs(currentPos.y - startPos.y) < 20) return;

    setIsDetecting(true);
    try {
      const rect = imgRef.current.getBoundingClientRect();
      const scaleX = image.width / rect.width;
      const scaleY = image.height / rect.height;

      const x = Math.min(startPos.x, currentPos.x) * scaleX;
      const y = Math.min(startPos.y, currentPos.y) * scaleY;
      const w = Math.abs(currentPos.x - startPos.x) * scaleX;
      const h = Math.abs(currentPos.y - startPos.y) * scaleY;

      const searchX = Math.max(0, Math.floor(x - 30));
      const searchY = Math.max(0, Math.floor(y - 30));
      const searchW = Math.min(image.width - searchX, Math.ceil(w + 60));
      const searchH = Math.min(image.height - searchY, Math.ceil(h + 60));

      const canvas = document.createElement('canvas');
      canvas.width = searchW;
      canvas.height = searchH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      ctx.drawImage(imgRef.current, searchX, searchY, searchW, searchH, 0, 0, searchW, searchH);
      const imgData = ctx.getImageData(0, 0, searchW, searchH);

      const mask48Data = await loadMaskData(mask48, 48);
      const mask96Data = await loadMaskData(mask96, 96);

      await new Promise(resolve => setTimeout(resolve, 10));

      const match48 = findBestMatch(imgData, mask48Data.data, 48);
      const match96 = findBestMatch(imgData, mask96Data.data, 96);

      let bestMatch = null;
      let bestSize = 48;

      if (match48 && match96) {
        const score48 = match48.score / (48 * 48);
        const score96 = match96.score / (96 * 96);
        if (score96 > score48) {
          bestMatch = match96;
          bestSize = 96;
        } else {
          bestMatch = match48;
          bestSize = 48;
        }
      } else if (match48) {
        bestMatch = match48;
      } else if (match96) {
        bestMatch = match96;
        bestSize = 96;
      }

      if (bestMatch) {
        const finalImgX = searchX + bestMatch.x;
        const finalImgY = searchY + bestMatch.y;
        setStartPos({ x: finalImgX / scaleX, y: finalImgY / scaleY });
        setCurrentPos({ x: (finalImgX + bestSize) / scaleX, y: (finalImgY + bestSize) / scaleY });
      }
    } catch (e) {
      console.error("Auto-detect failed", e);
    } finally {
      setIsDetecting(false);
    }
  };

  const handleConfirm = () => {
    if (!startPos || !currentPos || !imgRef.current || !image.width || !image.height) return;

    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = image.width / rect.width;
    const scaleY = image.height / rect.height;

    const x = Math.min(startPos.x, currentPos.x) * scaleX;
    const y = Math.min(startPos.y, currentPos.y) * scaleY;
    const w = Math.abs(currentPos.x - startPos.x) * scaleX;
    const h = Math.abs(currentPos.y - startPos.y) * scaleY;

    const size = Math.max(w, h);
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    const squareX = centerX - size / 2;
    const squareY = centerY - size / 2;

    onConfirm({ 
      size: Math.round(size), 
      marginRight: Math.round(image.width - (squareX + size)), 
      marginBottom: Math.round(image.height - (squareY + size)) 
    });
  };

  const selectionStyle = startPos && currentPos ? {
    left: Math.min(startPos.x, currentPos.x),
    top: Math.min(startPos.y, currentPos.y),
    width: Math.abs(currentPos.x - startPos.x),
    height: Math.abs(currentPos.y - startPos.y),
  } : {};

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-sm flex flex-col">
      <div className="h-16 border-b border-white/10 flex items-center justify-between px-6 shrink-0">
        <h3 className="text-white font-medium flex items-center gap-2">
          <Crop className="w-5 h-5" />
          手動框選浮水印位置
        </h3>
        <button onClick={onCancel} className="text-white/60 hover:text-white p-2">
          <X className="w-5 h-5" />
        </button>
      </div>
      
      <div className="flex-1 overflow-hidden flex items-center justify-center p-6 select-none">
        <div 
          ref={containerRef}
          className="relative inline-block cursor-crosshair shadow-2xl touch-none" // touch-none 防止系統手勢衝突
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <img 
            ref={imgRef}
            src={image.originalUrl} 
            alt="Select watermark" 
            className="max-w-full max-h-[calc(100vh-12rem)] w-auto h-auto block pointer-events-none"
            draggable={false}
          />
          {startPos && currentPos && (
            <div 
              className="absolute border-2 border-red-500 bg-red-500/20 pointer-events-none"
              style={selectionStyle}
            />
          )}
        </div>
      </div>

      <div className="h-20 border-t border-white/10 flex items-center justify-center gap-4 shrink-0 bg-slate-900">
        <span className="text-white/60 text-sm mr-4 hidden sm:inline">
          {isDetecting ? '正在自動鎖定浮水印...' : '請在上方圖片中，按住拖曳出浮水印的範圍'}
        </span>
        <button 
          onClick={onCancel}
          className="px-6 py-2.5 rounded-xl font-medium text-white hover:bg-white/10 transition-colors"
        >
          取消
        </button>
        <button 
          onClick={handleConfirm}
          disabled={!startPos || !currentPos || Math.abs(currentPos.x - startPos.x) < 5 || isDetecting}
          className="px-6 py-2.5 rounded-xl font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isDetecting ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4" />
          )}
          確認框選
        </button>
      </div>
    </div>
  );
};
```

**改動重點整理：**

1. **新增 `onTouchStart/Move/End`** — 對應 mouse 的三個事件，從 `e.touches[0]` 取得座標
2. **`e.preventDefault()`** — 防止觸控時觸發頁面捲動或系統手勢干擾拖曳
3. **`touch-none` class** — 在容器加上 Tailwind `touch-none`，讓瀏覽器把所有 touch 事件交給 JS 處理，避免 iOS Safari 的滾動攔截問題
4. **`containerRef`** — 座標計算改用 `containerRef` 綁定容器（原本直接用 `e.currentTarget`，touch 事件下有時會取到錯誤元素）
5. **`runAutoDetect` 抽成共用函式** — 避免 mouse/touch 重複同一段邏輯