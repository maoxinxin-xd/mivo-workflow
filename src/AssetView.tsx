import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Box, Download, File, Image, LoaderCircle, Play, Video, X } from 'lucide-react';
import { getSession, MivoClient } from './api';
import { useStudio } from './context';
import type { Asset } from './model';
import { signedUrl, type ResourceInfo } from './resource-cache';

function useObjectUrlCleanup(url: string) {
  useEffect(
    () => () => {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    },
    [url],
  );
}

function mediaKind(asset: Asset, info?: ResourceInfo) {
  const type = info?.contentType ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('model/') || type.includes('zip')) return 'model3d';
  if (asset.mediaType === 'speech') return 'audio';
  return asset.mediaType === 'model' ? 'model3d' : asset.mediaType;
}

export function AssetView({
  asset,
  label,
  onRemove,
}: {
  asset: Asset;
  label?: string;
  onRemove?: () => void;
}) {
  const studio = useStudio();
  const session = getSession(studio.environment);
  const owner = session?.owner;
  const version = session?.version;
  const client = useMemo(
    () => new MivoClient(studio.environment),
    [studio.environment, owner, version],
  );
  const [info, setInfo] = useState<ResourceInfo>();
  const [placeholder, setPlaceholder] = useState('');
  const [preview, setPreview] = useState('');
  const [previewReady, setPreviewReady] = useState(false);
  const [original, setOriginal] = useState('');
  const [opening, setOpening] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController>();
  const fallback = useRef(new Set<string>());
  useObjectUrlCleanup(placeholder);
  useObjectUrlCleanup(preview);
  useObjectUrlCleanup(original);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    fallback.current = new Set();
    setInfo(undefined);
    setPlaceholder('');
    setPreview('');
    setPreviewReady(false);
    setOriginal('');
    setOpening(false);
    setDownloading(false);
    setError('');
    setLoading(!!owner);
    if (!owner) return () => abort.abort();
    const load = async () => {
      let metadata: ResourceInfo | undefined;
      try {
        metadata = await client.resolveAsset(asset, abort.signal);
        if (metadata.status !== 'ok') {
          throw new Error(metadata.status === 'forbidden' ? '无权查看此资源' : '资源不可用');
        }
        setInfo(metadata);
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (metadata && metadata.status !== 'ok') throw reason;
        // A missing metadata endpoint must not force an original-file download.
      }
      const kind = mediaKind(asset, metadata);
      if (!['image', 'video', 'model3d'].includes(kind ?? '')) return;
      // The server returns originals for images over 20 MiB, even for placeholder profiles.
      if (
        kind === 'image' &&
        (!metadata || metadata.size === undefined || metadata.size > 20 * 1024 * 1024)
      )
        return;
      const profiles = metadata
        ? (['placeholder', 'preview-640'] as const)
        : (['preview-640'] as const);
      const urls = await client
        .assetUrls(asset, [...profiles], abort.signal)
        .catch(() => undefined);
      await Promise.all(
        profiles.map(async (profile) => {
          try {
            let url = urls && signedUrl(urls, profile);
            if (!url) {
              fallback.current.add(profile);
              const blob = await client.previewBlob(asset, profile, abort.signal);
              abort.signal.throwIfAborted();
              url = URL.createObjectURL(blob);
            }
            if (abort.signal.aborted) return;
            if (profile === 'placeholder') setPlaceholder(url);
            else setPreview(url);
          } catch {
            // A file without a cover still remains downloadable.
          }
        }),
      );
    };
    void load()
      .catch((reason) => {
        if (!abort.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '资源加载失败');
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [asset.fileId, asset.mediaType, client, owner]);

  async function fallbackPreview() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    if (fallback.current.has('preview-640')) {
      setPreview('');
      return;
    }
    fallback.current.add('preview-640');
    try {
      const blob = await client.previewBlob(asset, 'preview-640', signal);
      signal.throwIfAborted();
      setPreviewReady(false);
      setPreview(URL.createObjectURL(blob));
    } catch {
      if (!signal.aborted) setPreview('');
    }
  }

  async function openOriginal(forceBlob = false) {
    const current = controller.current;
    if (!owner || !current || current.signal.aborted || opening) return;
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(120_000)]);
    if (forceBlob && fallback.current.has('original')) {
      setError('资源播放失败，可下载原文件查看');
      return;
    }
    setOpening(true);
    setError('');
    try {
      let url: string | undefined;
      if (!forceBlob) {
        const urls = await client.assetUrls(asset, ['original'], signal).catch(() => undefined);
        url = urls && signedUrl(urls, 'original');
      }
      if (!url) {
        fallback.current.add('original');
        const blob = await client.blob(asset, signal);
        signal.throwIfAborted();
        url = URL.createObjectURL(blob);
      }
      signal.throwIfAborted();
      setOriginal(url);
    } catch (reason) {
      if (!current.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '资源加载失败');
      }
    } finally {
      if (!current.signal.aborted) setOpening(false);
    }
  }

  async function download() {
    const current = controller.current;
    if (!owner || !current || current.signal.aborted || downloading) return;
    setDownloading(true);
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(120_000)]);
      const blob = await client.blob(asset, signal, true);
      signal.throwIfAborted();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = asset.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (reason) {
      if (!current.signal.aborted) {
        studio.notify(reason instanceof Error ? reason.message : '下载失败');
      }
    } finally {
      if (!current.signal.aborted) setDownloading(false);
    }
  }

  const kind = mediaKind(asset, info);
  const Icon =
    kind === 'image'
      ? Image
      : kind === 'video'
        ? Video
        : kind === 'audio'
          ? AudioLines
          : kind === 'model3d'
            ? Box
            : File;
  const originalImage = kind === 'image' && !loading && !preview;
  const canOpen = !!owner && !error && (kind === 'video' || kind === 'audio' || originalImage);
  const ratio = info?.width && info?.height ? info.width / info.height : 16 / 9;
  const DownloadIcon = downloading ? LoaderCircle : Download;
  return (
    <div className="asset-item">
      {original && kind === 'video' ? (
        <video
          src={original}
          poster={preview || undefined}
          controls
          autoPlay
          preload="none"
          onError={() => void openOriginal(true)}
        />
      ) : original && kind === 'audio' ? (
        <audio
          src={original}
          controls
          autoPlay
          preload="none"
          onError={() => void openOriginal(true)}
        />
      ) : original && kind === 'image' ? (
        <img
          src={original}
          alt={label ?? asset.name}
          referrerPolicy="no-referrer"
          onError={() => void openOriginal(true)}
        />
      ) : (
        <div
          className={`asset-preview ${loading ? 'is-loading' : ''}`}
          style={kind === 'audio' || kind === 'file' ? { height: 80 } : { aspectRatio: ratio }}
          aria-busy={loading || opening}
        >
          {!previewReady && <Icon className="asset-preview-icon" size={28} strokeWidth={1.5} />}
          {placeholder && !previewReady && (
            <img
              className="asset-placeholder"
              src={placeholder}
              alt=""
              aria-hidden="true"
              referrerPolicy="no-referrer"
            />
          )}
          {preview && (
            <img
              className={`asset-preview-image ${previewReady ? 'is-ready' : ''}`}
              src={preview}
              alt={label ?? asset.name}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={() => setPreviewReady(true)}
              onError={() => void fallbackPreview()}
            />
          )}
          {canOpen && (
            <button
              type="button"
              className="asset-open"
              disabled={opening}
              onClick={() => void openOriginal()}
            >
              {opening ? (
                <LoaderCircle size={18} />
              ) : originalImage ? (
                <Image size={18} />
              ) : (
                <Play size={18} />
              )}
              <span>
                {opening
                  ? '加载中'
                  : originalImage
                    ? '查看原图'
                    : kind === 'audio'
                      ? '播放音频'
                      : '播放视频'}
              </span>
            </button>
          )}
        </div>
      )}
      <div className="asset-label">
        <span title={asset.name}>{label ?? asset.name}</span>
        {typeof info?.size === 'number' && Number.isFinite(info.size) && info.size > 0 && (
          <small className="asset-size">
            {info.size < 1024 * 1024
              ? `${Math.ceil(info.size / 1024)} KB`
              : `${(info.size / 1024 / 1024).toFixed(1)} MB`}
          </small>
        )}
        <button
          type="button"
          className="icon-button"
          title="下载原文件"
          aria-label="下载原文件"
          disabled={!owner || downloading}
          onClick={() => void download()}
        >
          <DownloadIcon size={14} />
        </button>
        {onRemove && (
          <button
            type="button"
            className="icon-button asset-remove"
            title="移除素材"
            aria-label="移除素材"
            onClick={onRemove}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {error && <small className="asset-error">{error}</small>}
      {!owner && <small className="asset-error">登录对应环境后可预览和下载</small>}
    </div>
  );
}
