import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Download, RefreshCw, Image as ImageIcon, Sparkles, ShieldCheck, Zap, Code, ArrowRight, CheckCircle2, AlertCircle, X, SplitSquareHorizontal, Settings, Crop } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { mask48, mask96 } from './masks';

type WatermarkConfig = {
  size: number;
  marginRight: number;
  marginBottom: number;
};

type ProcessedImage = {
  id: string;
  originalFile: File;
  originalUrl: string;
  processedUrl: string | null;
  status: 'pending' | 'processing' | 'completed' | 'error';
  aspectRatio?: string;
  width?: number;
  height?: number;
  config?: WatermarkConfig;
  version?: number;
};

// Helper to load base64 image into ImageData
const maskCache = new Map<string, ImageData>();

const loadMaskData = async (base64: string, size: number): Promise<ImageData> => {
  const cacheKey = `${base64.substring(0, 20)}_${size}`;
  if (maskCache.has(cacheKey)) {
    return maskCache.get(cacheKey)!;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get 2d context for mask'));
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      const imageData = ctx.getImageData(0, 0, size, size);
      maskCache.set(cacheKey, imageData);
      resolve(imageData);
    };
    img.onerror = reject;
    img.src = base64;
  });
};

// 反向 Alpha 混合演算法 (Reverse Alpha Compositing)
// 這是最完美的去浮水印方式。Gemini 的浮水印通常是半透明的白色或特定顏色。
// 假設浮水印顏色為 W (通常是白色 255,255,255)，透明度為 alpha (例如 0.15)
// 混合公式：Result = Original * (1 - alpha) + W * alpha
// 反向推導：Original = (Result - W * alpha) / (1 - alpha)
const applyReverseAlphaBlending = async (ctx: CanvasRenderingContext2D, width: number, height: number, config?: WatermarkConfig) => {
  // 根據圖片尺寸判斷浮水印大小與邊距
  // W <= 1024 or H <= 1024 -> 48x48, 32px margin
  // W > 1024 and H > 1024 -> 96x96, 64px margin
  const isLarge = width > 1024 && height > 1024;
  const watermarkSize = config?.size ?? (isLarge ? 96 : 48);
  const marginRight = config?.marginRight ?? (isLarge ? 64 : 32);
  const marginBottom = config?.marginBottom ?? (isLarge ? 64 : 32);

  const x0 = width - watermarkSize - marginRight;
  const y0 = height - watermarkSize - marginBottom;

  if (x0 < 0 || y0 < 0) return;

  // 載入對應的 Mask (如果是自訂尺寸，我們用較大的 mask96 來縮放以保持品質)
  const maskBase64 = watermarkSize > 48 ? mask96 : mask48;
  const maskImageData = await loadMaskData(maskBase64, watermarkSize);
  const maskData = maskImageData.data;

  const imgData = ctx.getImageData(x0, y0, watermarkSize, watermarkSize);
  const data = imgData.data;

  const logoValue = 255.0; // Gemini 浮水印是白色的
  const alphaThreshold = 0.002;
  const maxAlpha = 0.99;

  for (let i = 0; i < data.length; i += 4) {
    // Mask 是灰階的，RGB 值相同，我們取 R 通道作為 alpha 基準
    let alpha = maskData[i] / 255.0;

    if (alpha < alphaThreshold) {
      continue;
    }

    alpha = Math.min(alpha, maxAlpha);
    const oneMinusAlpha = 1.0 - alpha;

    for (let c = 0; c < 3; c++) {
      const watermarked = data[i + c];
      const original = (watermarked - alpha * logoValue) / oneMinusAlpha;
      data[i + c] = Math.min(255, Math.max(0, original));
    }
  }

  ctx.putImageData(imgData, x0, y0);
};

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
  const imgRef = useRef<HTMLImageElement>(null);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });
    setCurrentPos({ x, y });
    setIsDrawing(true);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    setCurrentPos({ x, y });
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
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

    // Force square based on max dimension
    const size = Math.max(w, h);
    // Center the square on the drawn rectangle
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    const squareX = centerX - size / 2;
    const squareY = centerY - size / 2;

    const marginRight = image.width - (squareX + size);
    const marginBottom = image.height - (squareY + size);

    onConfirm({ 
      size: Math.round(size), 
      marginRight: Math.round(marginRight), 
      marginBottom: Math.round(marginBottom) 
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
          className="relative inline-block cursor-crosshair shadow-2xl"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
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
        <span className="text-white/60 text-sm mr-4 hidden sm:inline">請在上方圖片中，按住滑鼠拖曳出浮水印的範圍</span>
        <button 
          onClick={onCancel}
          className="px-6 py-2.5 rounded-xl font-medium text-white hover:bg-white/10 transition-colors"
        >
          取消
        </button>
        <button 
          onClick={handleConfirm}
          disabled={!startPos || !currentPos || Math.abs(currentPos.x - startPos.x) < 5}
          className="px-6 py-2.5 rounded-xl font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4" />
          確認框選
        </button>
      </div>
    </div>
  );
};

export default function App() {
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [selectingImage, setSelectingImage] = useState<ProcessedImage | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const handleFiles = (files: File[]) => {
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    const newImages = imageFiles.map(file => ({
      id: Math.random().toString(36).substring(7),
      originalFile: file,
      originalUrl: URL.createObjectURL(file),
      processedUrl: null,
      status: 'pending' as const,
      version: 0,
    }));
    
    setImages(prev => [...newImages, ...prev]);
    
    newImages.forEach(img => processImage(img));
  };

  const removeImage = (id: string) => {
    setImages(prev => prev.filter(img => img.id !== id));
  };

  const updateImageConfig = (id: string, newConfig: WatermarkConfig) => {
    setImages(prev => {
      const img = prev.find(i => i.id === id);
      if (img) {
        const newVersion = (img.version || 0) + 1;
        processImage({ ...img, config: newConfig, version: newVersion }, true);
        return prev.map(i => i.id === id ? { ...i, config: newConfig, version: newVersion } : i);
      }
      return prev;
    });
  };

  const processImage = async (imageObj: ProcessedImage, isUpdate = false) => {
    if (!isUpdate) {
      setImages(prev => prev.map(img => img.id === imageObj.id ? { ...img, status: 'processing' } : img));
    }
    
    try {
      const img = new Image();
      img.src = imageObj.originalUrl;
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not get canvas context');

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      const width = canvas.width;
      const height = canvas.height;
      const ratio = width / height;
      
      let aspectRatioStr = '未知比例';

      if (Math.abs(ratio - 1) < 0.05) {
         aspectRatioStr = '1:1';
      } else if (Math.abs(ratio - 16/9) < 0.05) {
         aspectRatioStr = '16:9';
      } else if (Math.abs(ratio - 9/16) < 0.05) {
         aspectRatioStr = '9:16';
      } else if (Math.abs(ratio - 4/5) < 0.05) {
         aspectRatioStr = '4:5';
      } else if (Math.abs(ratio - 5/4) < 0.05) {
         aspectRatioStr = '5:4';
      }

      // We process the image in a non-blocking way to keep the UI responsive
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 使用反向 Alpha 混合演算法，完美還原像素
      await applyReverseAlphaBlending(ctx, width, height, imageObj.config);

      const processedUrl = canvas.toDataURL('image/png');

      setImages(prev => {
        const currentImg = prev.find(i => i.id === imageObj.id);
        // 如果這個處理任務的版本已經過期（使用者又調整了滑桿），就放棄更新
        if (currentImg && currentImg.version !== imageObj.version) {
          return prev;
        }
        return prev.map(img => 
          img.id === imageObj.id 
            ? { ...img, status: 'completed', processedUrl, aspectRatio: aspectRatioStr, width, height } 
            : img
        );
      });

    } catch (error) {
      console.error(error);
      setImages(prev => prev.map(img => img.id === imageObj.id ? { ...img, status: 'error' } : img));
    }
  };

  const downloadImage = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `cleaned_${filename}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-red-100 selection:text-red-900">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-slate-200/60 bg-white/80 backdrop-blur-xl">
        <div className="container mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-red-600 flex items-center justify-center shadow-sm shadow-red-600/20">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-900">RedJack Gemini去浮水印</span>
          </div>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
            <a href="#how-it-works" className="hover:text-slate-900 transition-colors">特色功能</a>
            <a href="#faq" className="hover:text-slate-900 transition-colors">常見問題</a>
          </nav>
          <div className="flex items-center gap-4">
            <a href="https://github.com" target="_blank" rel="noreferrer" className="hidden sm:flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">
              <Code className="w-4 h-4" />
              <span>開放原始碼</span>
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* Hero Section */}
        <section className="relative pt-20 pb-24 lg:pt-32 lg:pb-32 overflow-hidden">
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_60%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))]"></div>
          
          <div className="container mx-auto max-w-4xl px-6 text-center">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-50 border border-red-100 text-red-600 text-sm font-medium mb-8"
            >
              <Sparkles className="w-4 h-4" />
              <span>完美支援 1:1, 4:5, 16:9, 9:16, 5:4 比例</span>
            </motion.div>
            
            <motion.h1 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-4xl md:text-6xl lg:text-7xl font-extrabold tracking-tight text-slate-900 mb-6"
            >
              一鍵去除 Gemini 圖片浮水印 <br className="hidden md:block" />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-600 to-orange-500">極速、無痕、純本地端</span>
            </motion.h1>
            
            <motion.p 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-lg md:text-xl text-slate-600 mb-12 max-w-2xl mx-auto leading-relaxed"
            >
              純瀏覽器本地端處理。拖曳 Gemini 生成的圖片，立即無痕去除 AI 浮水印。採用「反向 Alpha 混合 (Reverse Alpha Compositing)」技術，像素級還原真實背景。完全免費。
            </motion.p>

            {/* Uploader */}
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="max-w-2xl mx-auto"
            >
              <div 
                className={`relative group rounded-3xl border-2 border-dashed transition-all duration-300 bg-white/50 backdrop-blur-sm overflow-hidden
                  ${isDragging ? 'border-red-500 bg-red-50/50' : 'border-slate-200 hover:border-red-300 hover:bg-slate-50/50'}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileInput}
                  accept="image/png, image/jpeg, image/webp"
                  multiple
                  className="hidden" 
                />
                
                <div className="px-8 py-16 flex flex-col items-center justify-center gap-6 cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                  <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <Upload className="w-8 h-8 text-red-600" />
                  </div>
                  <div className="space-y-2 text-center">
                    <h3 className="text-xl font-semibold text-slate-900">選擇圖片或拖曳至此</h3>
                    <p className="text-slate-500 font-medium">支援 PNG, JPG, WEBP 格式</p>
                  </div>
                  
                  <div className="flex flex-wrap items-center justify-center gap-4 text-xs font-medium text-slate-500 mt-4">
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-emerald-500" />
                      <span>100% 本地處理</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Zap className="w-4 h-4 text-amber-500" />
                      <span>極速處理</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Workspace / Results */}
        {images.length > 0 && (
          <section className="py-12 bg-white border-y border-slate-200/60">
            <div className="container mx-auto max-w-6xl px-6">
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-2xl font-bold text-slate-900">已處理圖片</h2>
                <button 
                  onClick={() => setImages([])}
                  className="text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors"
                >
                  全部清除
                </button>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <AnimatePresence>
                  {images.map((img) => (
                    <motion.div 
                      key={img.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden flex flex-col"
                    >
                      <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-white">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                            <ImageIcon className="w-5 h-5 text-slate-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900 truncate">{img.originalFile.name}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-slate-500">{(img.originalFile.size / 1024 / 1024).toFixed(2)} MB</span>
                              {img.aspectRatio && (
                                <>
                                  <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                                  <span className="text-xs font-medium text-red-600 bg-red-50 px-1.5 py-0.5 rounded-md">比例: {img.aspectRatio}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {img.status === 'completed' && (
                            <button 
                              onClick={() => setAdjustingId(adjustingId === img.id ? null : img.id)}
                              className={`p-2 rounded-lg transition-colors ${adjustingId === img.id ? 'text-red-600 bg-red-50' : 'text-slate-400 hover:text-slate-900 hover:bg-slate-100'}`}
                              title="微調浮水印位置"
                            >
                              <Settings className="w-4 h-4" />
                            </button>
                          )}
                          <button 
                            onClick={() => removeImage(img.id)}
                            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div className="p-6 flex-1 flex flex-col items-center justify-center relative min-h-[240px]">
                        {img.status === 'pending' || img.status === 'processing' ? (
                          <div className="flex flex-col items-center gap-4">
                            <RefreshCw className="w-8 h-8 text-red-500 animate-spin" />
                            <p className="text-sm font-medium text-slate-600">處理中...</p>
                          </div>
                        ) : img.status === 'error' ? (
                          <div className="flex flex-col items-center gap-4 text-red-500">
                            <AlertCircle className="w-8 h-8" />
                            <p className="text-sm font-medium">處理失敗</p>
                          </div>
                        ) : (
                          <div className="w-full flex flex-col gap-4">
                            <div className="relative rounded-xl overflow-hidden bg-slate-200 aspect-video w-full group">
                              <img 
                                src={img.processedUrl!} 
                                alt="處理後" 
                                className="absolute inset-0 w-full h-full object-contain"
                              />
                              
                              {/* Hover to see original */}
                              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                                <img 
                                  src={img.originalUrl} 
                                  alt="原圖" 
                                  className="absolute inset-0 w-full h-full object-contain"
                                />
                                <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white text-xs font-bold px-2.5 py-1 rounded-md">
                                  原圖
                                </div>
                              </div>
                              
                              <div className="absolute top-3 left-3 bg-red-600/90 backdrop-blur-md text-white text-xs font-bold px-2.5 py-1 rounded-md group-hover:opacity-0 transition-opacity duration-300">
                                處理後
                              </div>
                              
                              <div className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md text-white text-xs font-medium px-2.5 py-1 rounded-md flex items-center gap-1.5 opacity-100 group-hover:opacity-0 transition-opacity duration-300">
                                <SplitSquareHorizontal className="w-3.5 h-3.5" />
                                懸停以對比
                              </div>
                            </div>
                            
                            {adjustingId === img.id && img.width && img.height && (
                              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col gap-4 shadow-sm">
                                <div className="flex items-center justify-between">
                                  <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                                    <Settings className="w-4 h-4 text-slate-500" />
                                    微調浮水印位置
                                  </h4>
                                  <button onClick={() => setAdjustingId(null)} className="text-slate-400 hover:text-slate-600">
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                                
                                <div className="grid grid-cols-1 gap-4">
                                  <div className="flex flex-col gap-2">
                                    <div className="flex justify-between items-center">
                                      <label className="text-xs font-medium text-slate-600">大小 (Size)</label>
                                      <span className="text-xs text-slate-500">{img.config?.size ?? (img.width > 1024 && img.height > 1024 ? 96 : 48)}px</span>
                                    </div>
                                    <input 
                                      type="range" 
                                      min="16" max="256" step="1"
                                      value={img.config?.size ?? (img.width > 1024 && img.height > 1024 ? 96 : 48)} 
                                      onChange={(e) => updateImageConfig(img.id, { 
                                        size: parseInt(e.target.value), 
                                        marginRight: img.config?.marginRight ?? (img.width! > 1024 && img.height! > 1024 ? 64 : 32),
                                        marginBottom: img.config?.marginBottom ?? (img.width! > 1024 && img.height! > 1024 ? 64 : 32)
                                      })}
                                      className="w-full accent-red-500"
                                    />
                                  </div>
                                  
                                  <div className="flex flex-col gap-2">
                                    <div className="flex justify-between items-center">
                                      <label className="text-xs font-medium text-slate-600">右邊距 (Margin Right)</label>
                                      <span className="text-xs text-slate-500">{img.config?.marginRight ?? (img.width > 1024 && img.height > 1024 ? 64 : 32)}px</span>
                                    </div>
                                    <input 
                                      type="range" 
                                      min="0" max="256" step="1"
                                      value={img.config?.marginRight ?? (img.width > 1024 && img.height > 1024 ? 64 : 32)} 
                                      onChange={(e) => updateImageConfig(img.id, { 
                                        size: img.config?.size ?? (img.width! > 1024 && img.height! > 1024 ? 96 : 48),
                                        marginRight: parseInt(e.target.value),
                                        marginBottom: img.config?.marginBottom ?? (img.width! > 1024 && img.height! > 1024 ? 64 : 32)
                                      })}
                                      className="w-full accent-red-500"
                                    />
                                  </div>

                                  <div className="flex flex-col gap-2">
                                    <div className="flex justify-between items-center">
                                      <label className="text-xs font-medium text-slate-600">下邊距 (Margin Bottom)</label>
                                      <span className="text-xs text-slate-500">{img.config?.marginBottom ?? (img.width > 1024 && img.height > 1024 ? 64 : 32)}px</span>
                                    </div>
                                    <input 
                                      type="range" 
                                      min="0" max="256" step="1"
                                      value={img.config?.marginBottom ?? (img.width > 1024 && img.height > 1024 ? 64 : 32)} 
                                      onChange={(e) => updateImageConfig(img.id, { 
                                        size: img.config?.size ?? (img.width! > 1024 && img.height! > 1024 ? 96 : 48),
                                        marginRight: img.config?.marginRight ?? (img.width! > 1024 && img.height! > 1024 ? 64 : 32),
                                        marginBottom: parseInt(e.target.value)
                                      })}
                                      className="w-full accent-red-500"
                                    />
                                  </div>
                                </div>
                                
                                <button 
                                  onClick={() => {
                                    setSelectingImage(img);
                                    setAdjustingId(null);
                                  }}
                                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors mt-2"
                                >
                                  <Crop className="w-4 h-4" />
                                  手動框選浮水印
                                </button>
                              </div>
                            )}

                            <button 
                              onClick={() => downloadImage(img.processedUrl!, img.originalFile.name)}
                              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-medium flex items-center justify-center gap-2 transition-colors"
                            >
                              <Download className="w-4 h-4" />
                              下載去浮水印圖片
                            </button>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </section>
        )}

        {/* Features */}
        <section id="how-it-works" className="py-24 bg-slate-50">
          <div className="container mx-auto max-w-6xl px-6">
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">為什麼選擇 RedJack Gemini去浮水印？</h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">專為隱私與效能打造，無需伺服器，無需等待。</p>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center mb-6">
                  <ShieldCheck className="w-6 h-6 text-emerald-600" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-3">純本地端處理</h3>
                <p className="text-slate-600 leading-relaxed">
                  所有運算都在您的瀏覽器中完成。圖片絕不會上傳到任何伺服器，確保 100% 的隱私安全與零資料外洩風險。
                </p>
              </div>
              
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <div className="w-12 h-12 rounded-2xl bg-red-50 flex items-center justify-center mb-6">
                  <Sparkles className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-3">智慧比例偵測</h3>
                <p className="text-slate-600 leading-relaxed">
                  自動偵測常見的 Gemini 圖片比例 (1:1, 16:9, 9:16, 4:5, 5:4)，精準定位並去除浮水印。
                </p>
              </div>

              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center mb-6">
                  <Zap className="w-6 h-6 text-amber-600" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-3">支援批次處理</h3>
                <p className="text-slate-600 leading-relaxed">
                  可一次加入多張圖片，利用您設備的運算能力進行平行的極速處理。
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="py-24 bg-white border-t border-slate-200/60">
          <div className="container mx-auto max-w-3xl px-6">
            <h2 className="text-3xl font-bold text-slate-900 text-center mb-12">常見問題</h2>
            
            <div className="space-y-6">
              <div className="border-b border-slate-200 pb-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-2">我的圖片真的不會上傳到伺服器嗎？</h3>
                <p className="text-slate-600">100% 保證。所有的處理都在您瀏覽器的 Canvas 中進行，圖片資料絕不會離開您的設備。您可以斷網使用本工具來驗證。</p>
              </div>
              <div className="border-b border-slate-200 pb-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-2">支援哪些圖片格式？</h3>
                <p className="text-slate-600">支援 PNG、JPG/JPEG 以及 WEBP 格式。Google Gemini 通常會生成 JPEG 格式的圖片。</p>
              </div>
              <div className="border-b border-slate-200 pb-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-2">如何處理不同的圖片比例？</h3>
                <p className="text-slate-600">工具會自動偵測圖片的解析度，並套用對應的 48x48 或 96x96 精準遮罩，完美支援 1:1、4:5、16:9、9:16 和 5:4 等所有 Gemini 產生的格式。</p>
              </div>
              <div className="border-b border-slate-200 pb-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-2">去浮水印的效果如何？會破壞畫質嗎？</h3>
                <p className="text-slate-600">本工具採用與 pilio.ai 相同的「反向 Alpha 混合 (Reverse Alpha Compositing)」技術，透過數學公式反推還原被浮水印遮蓋的原始像素，達到像素級無損還原，完全不會破壞畫質或產生模糊。</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-slate-50 py-12 border-t border-slate-200">
        <div className="container mx-auto max-w-6xl px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-red-600" />
            <span className="font-bold text-lg text-slate-900">RedJack Gemini去浮水印</span>
          </div>
          <p className="text-sm text-slate-500 font-medium">
            © {new Date().getFullYear()} RedJack. Free online AI tools.
          </p>
        </div>
      </footer>

      {/* Selection Modal */}
      {selectingImage && (
        <WatermarkSelector 
          image={selectingImage}
          onConfirm={(config) => {
            updateImageConfig(selectingImage.id, config);
            setSelectingImage(null);
            setAdjustingId(selectingImage.id); // Re-open adjusting panel to show new values
          }}
          onCancel={() => setSelectingImage(null)}
        />
      )}
    </div>
  );
}