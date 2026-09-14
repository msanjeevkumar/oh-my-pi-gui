import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { type ComposerAnnotation, useComposerStore } from "../../stores/composer";
import { useSessionStore } from "../../stores/session";

/** Ignore code-block controls: their labels can change without changing the response. */
function* textNodes(root: HTMLElement): Generator<Text> {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if (!node.parentElement?.closest(".select-none")) yield node as Text;
		node = walker.nextNode();
	}
}

function selectedOffsets(root: HTMLElement, range: Range): { start: number; end: number } | null {
	let offset = 0;
	let start: number | undefined;
	let end = 0;
	for (const node of textNodes(root)) {
		if (node === range.startContainer) start = offset + range.startOffset;
		else if (start === undefined && range.comparePoint(node, 0) === 0) start = offset;
		if (node === range.endContainer) end = offset + range.endOffset;
		else if (range.comparePoint(node, node.length) === 0) end = offset + node.length;
		offset += node.length;
	}
	return start !== undefined && end > start ? { start, end } : null;
}

function restoreRange(root: HTMLElement, start: number, end: number): Range | null {
	const range = document.createRange();
	let offset = 0;
	let started = false;
	for (const node of textNodes(root)) {
		if (!started && start < offset + node.length) {
			range.setStart(node, start - offset);
			started = true;
		}
		if (started && end <= offset + node.length) {
			range.setEnd(node, end - offset);
			return range;
		}
		offset += node.length;
	}
	return null;
}

/** One finalized response block; composer state owns annotations, DOM ranges only paint them. */
export function ResponseAnnotations({
	message,
	block,
	children,
}: {
	message: string;
	block: number;
	children: ReactNode;
}) {
	const t = useT();
	const annotations = useComposerStore(state => state.annotations);
	const setAnnotations = useComposerStore(state => state.setAnnotations);
	const readOnly = useSessionStore(state => state.collab?.readOnly === true);
	const sourceRef = useRef<HTMLDivElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const commentRef = useRef<HTMLTextAreaElement>(null);
	const badgeRefs = useRef(new Map<string, HTMLButtonElement>());
	const [selection, setSelection] = useState<{ text: string; range: Range; start: number; end: number } | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [comment, setComment] = useState("");
	const [badges, setBadges] = useState<{ id: string; left: number; top: number }[]>([]);
	const [position, setPosition] = useState({ left: 8, top: 8 });
	const annotation = annotations.find(item => item.id === editing);
	const popupOpen = selection !== null || annotation !== undefined;

	const closeEditor = () => {
		if (editing) badgeRefs.current.get(editing)?.focus();
		setEditing(null);
	};

	useLayoutEffect(() => {
		const source = sourceRef.current;
		if (!source || typeof Highlight === "undefined") return;
		const highlight = CSS.highlights.get("response-annotations") ?? new Highlight();
		CSS.highlights.set("response-annotations", highlight);
		const ranges: { id: string; range: Range; endpoint: Range }[] = [];
		for (const item of annotations) {
			if (item.source?.message !== message || item.source.block !== block) continue;
			const range = restoreRange(source, item.source.start, item.source.end);
			if (!range) continue;
			highlight.add(range);
			const endpoint = range.cloneRange();
			endpoint.collapse(false);
			ranges.push({ id: item.id, range, endpoint });
		}
		const place = () => {
			const origin = source.getBoundingClientRect();
			setBadges(
				ranges.map(({ id, endpoint }) => {
					const rect = endpoint.getBoundingClientRect();
					return { id, left: rect.right - origin.left + 4, top: rect.top - origin.top + 2 };
				}),
			);
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(source);
		source.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			source.removeEventListener("scroll", place, true);
			for (const { range } of ranges) highlight.delete(range);
			if (highlight.size === 0) CSS.highlights.delete("response-annotations");
		};
	}, [annotations, message, block]);

	useLayoutEffect(() => {
		if (!popupOpen) return;
		const place = () => {
			const rect =
				selection?.range.getBoundingClientRect() ?? badgeRefs.current.get(editing ?? "")?.getBoundingClientRect();
			const popup = popupRef.current;
			if (!rect || !popup) return;
			const { width, height } = popup.getBoundingClientRect();
			setPosition({
				left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
				top: Math.max(
					8,
					Math.min(
						rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8,
						window.innerHeight - height - 8,
					),
				),
			});
		};
		place();
		if (annotation) commentRef.current?.focus();
		const observer = new ResizeObserver(place);
		if (popupRef.current) observer.observe(popupRef.current);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (popupRef.current?.contains(target)) return;
			if ([...badgeRefs.current.values()].some(badge => badge.contains(target))) return;
			setSelection(null);
			setEditing(null);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setSelection(null);
			if (editing) badgeRefs.current.get(editing)?.focus();
			setEditing(null);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [popupOpen, selection, editing, annotation]);

	useEffect(() => {
		if (editing && !annotation) setEditing(null);
		if (readOnly) {
			setSelection(null);
			setEditing(null);
		}
	}, [annotation, editing, readOnly]);

	const selectResponse = () => {
		const current = window.getSelection();
		const source = sourceRef.current;
		if (readOnly || !source || !current || current.isCollapsed || !current.rangeCount) return;
		const range = current.getRangeAt(0);
		const text = current.toString();
		if (!text.trim() || !source.contains(range.startContainer) || !source.contains(range.endContainer)) return;
		const offsets = selectedOffsets(source, range);
		if (!offsets) return;
		setSelection({ text, range: range.cloneRange(), ...offsets });
	};

	const add = () => {
		if (!selection || readOnly) return;
		const item: ComposerAnnotation = {
			id: crypto.randomUUID(),
			text: selection.text,
			comment: "",
			source: { message, block, start: selection.start, end: selection.end },
		};
		setAnnotations(current => [...current, item]);
		setSelection(null);
		setComment("");
		setEditing(item.id);
		window.getSelection()?.removeAllRanges();
	};

	return (
		<div className="relative">
			<div ref={sourceRef} data-response-annotation-text onMouseUp={selectResponse} onKeyUp={selectResponse}>
				{children}
			</div>
			{badges.map(({ id, left, top }) => (
				<button
					key={id}
					ref={node => {
						if (node) badgeRefs.current.set(id, node);
						else badgeRefs.current.delete(id);
					}}
					type="button"
					className="omp-annotation-badge"
					style={{ left, top }}
					aria-label={t("chat.annotation", { index: annotations.findIndex(item => item.id === id) + 1 })}
					aria-expanded={editing === id}
					disabled={readOnly}
					onClick={() => {
						setSelection(null);
						setComment(annotations.find(item => item.id === id)?.comment ?? "");
						setEditing(id);
					}}
				>
					{annotations.findIndex(item => item.id === id) + 1}
				</button>
			))}
			{popupOpen &&
				createPortal(
					<div
						ref={popupRef}
						className="omp-annotation-popup"
						style={position}
						role={annotation ? "dialog" : "toolbar"}
						aria-label={
							annotation
								? t("chat.annotation", { index: annotations.indexOf(annotation) + 1 })
								: t("chat.addToChat")
						}
					>
						{annotation ? (
							<>
								<label className="mb-2 block text-omp-sm">
									{t("chat.annotationComment")}
									<textarea
										ref={commentRef}
										value={comment}
										onChange={event => setComment(event.target.value)}
										className="mt-2 block w-full resize-y rounded-md border border-[var(--omp-border)] bg-[var(--omp-bg)] p-2 text-omp-base outline-none focus:border-[var(--omp-border-accent)]"
										rows={3}
									/>
								</label>
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="omp-annotation-action"
										aria-label={t("chat.deleteAnnotation", { index: annotations.indexOf(annotation) + 1 })}
										onClick={() => {
											setAnnotations(current => current.filter(item => item.id !== annotation.id));
											closeEditor();
										}}
									>
										<Trash2 size={15} />
									</button>
									<span className="flex-1" />
									<button type="button" className="omp-annotation-action" onClick={closeEditor}>
										{t("common.cancel")}
									</button>
									<button
										type="button"
										className="omp-annotation-action"
										disabled={!comment.trim()}
										onClick={() => {
											setAnnotations(current =>
												current.map(item =>
													item.id === annotation.id ? { ...item, comment: comment.trim() } : item,
												),
											);
											closeEditor();
										}}
									>
										{t("common.save")}
									</button>
								</div>
							</>
						) : (
							<button
								type="button"
								className="omp-annotation-action"
								onMouseDown={event => event.preventDefault()}
								onClick={add}
							>
								{t("chat.addToChat")}
							</button>
						)}
					</div>,
					document.body,
				)}
		</div>
	);
}
