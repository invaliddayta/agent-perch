/** Images in the boss chat: prepare (downscale) before upload, thumbnails, and a full-size viewer. */
import { useEffect, useState } from "preact/hooks";
import { Icon } from "./ui.tsx";

export interface Pending {
	mimeType: string;
	data: string; // base64
	url: string; // object URL for the preview
	name: string;
}

// Models see about 1.15 megapixels anyway (Anthropic downscales above ~1568 px on the long edge).
const MAX = 1568;
const KEEP_BYTES = 1_500_000;
const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const b64 = (blob: Blob) =>
	new Promise<string>((res, rej) => {
		const r = new FileReader();
		r.onload = () => res(String(r.result).split(",")[1] ?? "");
		r.onerror = () => rej(r.error);
		r.readAsDataURL(blob);
	});

/** A picked, pasted or dropped image, downscaled for the model. Screenshots stay PNG, photos become JPEG. */
export async function prepare(file: File): Promise<Pending> {
	if (!file.type.startsWith("image/")) throw new Error(`${file.name || "file"} is not an image`);
	let bmp: ImageBitmap;
	try {
		bmp = await createImageBitmap(file); // applies EXIF orientation
	} catch {
		throw new Error(`cannot read ${file.name || "this image"} (${file.type || "unknown type"})`);
	}
	const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
	let out: Blob = file;
	let type = file.type;
	if (scale < 1 || !OK_TYPES.includes(type) || file.size > KEEP_BYTES || type === "image/webp") {
		const w = Math.round(bmp.width * scale);
		const h = Math.round(bmp.height * scale);
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
		const png = type === "image/png" || type === "image/gif";
		const enc = (t: string, q?: number) => new Promise<Blob | null>((res) => c.toBlob(res, t, q));
		let blob = png ? await enc("image/png") : null;
		if (!blob || blob.size > 3_000_000) blob = await enc("image/jpeg", 0.86);
		if (!blob) throw new Error("could not encode the image");
		out = blob;
		type = blob.type;
	}
	bmp.close();
	return { mimeType: type, data: await b64(out), url: URL.createObjectURL(out), name: file.name };
}

export const imageFiles = (list: FileList | DataTransferItemList | null | undefined): File[] => {
	const out: File[] = [];
	if (!list) return out;
	for (const it of Array.from(list as ArrayLike<File | DataTransferItem>)) {
		const f = it instanceof File ? it : it.kind === "file" ? it.getAsFile() : null;
		if (f && f.type.startsWith("image/")) out.push(f);
	}
	return out;
};

// ---------------------------------------------------------------- viewer

let open: string | undefined;
const subs = new Set<() => void>();
export function viewImage(src?: string) {
	open = src;
	subs.forEach((f) => f());
}

export function Lightbox() {
	const [, set] = useState(0);
	useEffect(() => {
		const f = () => set((n) => n + 1);
		subs.add(f);
		const k = (e: KeyboardEvent) => e.key === "Escape" && open && viewImage();
		addEventListener("keydown", k);
		return () => {
			subs.delete(f);
			removeEventListener("keydown", k);
		};
	}, []);
	if (!open) return null;
	return (
		<div class="lightbox" onClick={() => viewImage()}>
			<img src={open} alt="" />
			<div class="lbbar">
				<a class="btn" href={open} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
					Open in new tab
				</a>
				<button class="iconbtn" aria-label="Close" onClick={() => viewImage()}>
					<Icon n="x" />
				</button>
			</div>
		</div>
	);
}

export function Thumbs({ names, small }: { names?: string[]; small?: boolean }) {
	if (!names?.length) return null;
	return (
		<div class={`thumbs ${small ? "small" : ""} n${Math.min(names.length, 3)}`}>
			{names.map((n) => (
				<button type="button" class="thumb" onClick={() => viewImage(`/media/${n}`)} aria-label="View image">
					<img src={`/media/${n}`} alt="" loading="lazy" decoding="async" />
				</button>
			))}
		</div>
	);
}
