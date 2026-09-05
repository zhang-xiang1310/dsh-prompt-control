/**
 * DSH提示词 client half (deployment-persistent bundle plugin).
 *
 * Registers one page ("DSH提示词") in the Settings left nav (settings.section
 * occupant). The page is split into two regions: the top shows the current
 * DEFAULT DSH system prompt (read-only, dynamic), the bottom is an editable
 * textarea for user-appended guidance. The appended text is NOT merged into
 * either displayed region; it is only concatenated as the last section of the
 * rendered system message when the model request is actually assembled. 保存
 * stores the bottom text as that append. Talks to the host
 * half through plain same-origin fetch on the /dshp/api routes.
 */
window.__ModuleLoader__.load({
	id: 'dsh-prompt-control',
	factory: (require) => {
		var module = { exports: {} };

		const react = require('react');
		const { useState, useEffect, useRef, useCallback } = react;

		// ---- injected styles (idempotent across page reloads / re-activation)
		const CSS_TAG = 'dsh-prompt-control/ui.css';
		const CSS = [
			'.dshp-root{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;max-width:820px}',
			'.dshp-pane{display:flex;flex-direction:column;gap:6px;min-height:0;flex:1 1 0}',
			'.dshp-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);letter-spacing:.02em}',
			'.dshp-text{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:vertical;white-space:pre-wrap;overflow-wrap:break-word;background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#d0d5dd);border-radius:8px;padding:10px 12px;font:13px/1.65 ui-monospace,"Cascadia Code",Consolas,Menlo,monospace;outline:none}',
			'.dshp-text:focus{border-color:var(--dsw-alias-interactive-border-focus,#3b82f6)}',
			'.dshp-text:disabled{opacity:.6}',
			'.dshp-readonly{flex:1 1 auto;min-height:0;resize:none;cursor:default;opacity:.92}',
			'.dshp-edit{flex:1 1 auto;min-height:0}',
			'.dshp-hint{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:1.5;white-space:pre-wrap}',
			'.dshp-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.dshp-status{margin-right:auto;font-size:12px}',
			'.dshp-status-ok{color:var(--dsw-alias-state-success-primary,#128a4a)}',
			'.dshp-status-err{color:var(--dsw-alias-state-danger-primary,#d92d20)}',
			'.dshp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#d0d5dd);background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:var(--dsw-alias-label-primary,#1f2329);border-radius:6px;padding:5px 14px;font-size:13px;cursor:pointer}',
			'.dshp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#eceef1)}',
			'.dshp-btn:disabled{opacity:.55;cursor:not-allowed}',
			'.dshp-primary{background:#3b82f6;border-color:transparent;color:#ffffff}',
			'.dshp-primary:hover:not(:disabled){background:#2f6fe0}',
			'[data-theme="dark"] .dshp-text{background:var(--dsw-alias-bg-layer-2,#16181d);color:var(--dsw-alias-label-primary,#e6e8eb);border-color:var(--dsw-alias-border-l1,#33363e)}',
			'[data-theme="dark"] .dshp-text:focus{border-color:var(--dsw-alias-interactive-border-focus,#3b82f6)}',
			'[data-theme="dark"] .dshp-btn{background:var(--dsw-alias-bg-layer-1,#1f2229);color:var(--dsw-alias-label-primary,#e6e8eb);border-color:var(--dsw-alias-border-l1,#33363e)}',
			'[data-theme="dark"] .dshp-primary,[data-theme="dark"] .dshp-primary:hover:not(:disabled){background:#3b82f6;border-color:transparent;color:#ffffff}',
		].join('\n');
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
			const tag = document.createElement('style');
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---- page component
		const COPY = {
			labelSystem: '当前系统提示词（只读 · 动态）',
			labelAppend: '你的追加内容（追加到系统提示词末尾）',
			placeholderSystem: '（正在读取当前系统提示词…）',
			placeholderAppend: '在此输入要追加到系统提示词末尾的内容…',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			dirty: '有未保存的修改',
			systemEmptyHint: '尚未读取到系统提示词（还没有生成请求头的会话）。',
			appendHint: '保存后，此处内容会作为最后一段追加到每个会话的 system 消息末尾；它不会覆盖 DSH 的动态系统提示词。清空此处内容后点保存，可移除该追加。Ctrl/Cmd+S 快速保存。',
		};

		async function callApi(method, payload) {
			const response = await fetch(`/dshp/api/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload ?? {}),
			});
			let data = null;
			try {
				data = await response.json();
			} catch {
				// Non-JSON body (e.g. an HTML error page).
			}
			if (!response.ok || data === null || data.ok !== true) {
				const detail = data !== null && data.error && typeof data.error === 'object'
					? data.error.message || data.error.code
					: `HTTP ${response.status}`;
				throw new Error(detail || 'unknown error');
			}
			return data.value;
		}

		function PromptPage() {
			const [system, setSystem] = useState('');
			const [append, setAppend] = useState('');
			const [initialAppend, setInitialAppend] = useState('');
			const [loading, setLoading] = useState(true);
			const [busy, setBusy] = useState(false);
			const [status, setStatus] = useState('idle');
			const [error, setError] = useState('');
			const dirty = !loading && append !== initialAppend;

			const load = useCallback(async () => {
				setLoading(true);
				try {
					const value = await callApi('state', {});
					setSystem(typeof value.system === 'string' ? value.system : '');
					const next = typeof value.appended === 'string' ? value.appended : '';
					setAppend(next);
					setInitialAppend(next);
					setStatus('idle');
					setError('');
				} catch (err) {
					setStatus('error');
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setLoading(false);
				}
			}, []);

			useEffect(() => {
				load().catch(() => {});
			}, [load]);

			const doSave = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				setError('');
				try {
					const value = await callApi('save', { text: append });
					setSystem(typeof value.system === 'string' ? value.system : '');
					const next = typeof value.appended === 'string' ? value.appended : '';
					setAppend(next);
					setInitialAppend(next);
					setStatus('saved');
				} catch (err) {
					setStatus('error');
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}, [busy, append]);

			const onKeyDown = (event) => {
				if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
					event.preventDefault();
					doSave().catch(() => {});
				}
			};

			let statusNode = null;
			if (status === 'error') {
				statusNode = react.createElement('span', { className: 'dshp-status dshp-status-err' }, `操作失败：${error}`);
			} else if (busy) {
				statusNode = react.createElement('span', { className: 'dshp-status dshp-status-ok' }, COPY.saving);
			} else if (status === 'saved') {
				statusNode = react.createElement('span', { className: 'dshp-status dshp-status-ok' }, COPY.saved);
			} else if (dirty) {
				statusNode = react.createElement('span', { className: 'dshp-status' }, COPY.dirty);
			} else {
				statusNode = null;
			}

			// Top region: read-only current default system prompt.
			const systemPane = react.createElement(
				'div',
				{ className: 'dshp-pane' },
				react.createElement('div', { className: 'dshp-label' }, COPY.labelSystem),
				react.createElement('textarea', {
					className: 'dshp-text dshp-readonly',
					value: system === '' && loading ? '' : system,
					readOnly: true,
					placeholder: COPY.placeholderSystem,
					spellCheck: false,
					disabled: loading,
				}),
			);

			// Bottom region: editable appended text.
			const appendPane = react.createElement(
				'div',
				{ className: 'dshp-pane' },
				react.createElement('div', { className: 'dshp-label' }, COPY.labelAppend),
				react.createElement('textarea', {
					className: 'dshp-text dshp-edit',
					value: append,
					onChange: (event) => setAppend(event.target.value),
					onKeyDown,
					placeholder: COPY.placeholderAppend,
					spellCheck: false,
					disabled: loading || busy,
				}),
			);

			const systemHint = system === '' && !loading && status !== 'error' ? COPY.systemEmptyHint : '';
			const hint = react.createElement(
				'div',
				{ className: 'dshp-hint' },
				react.createElement('div', {}, systemHint),
				react.createElement('div', {}, COPY.appendHint),
			);
			const foot = react.createElement(
				'div',
				{ className: 'dshp-foot' },
				statusNode,
				react.createElement('button', {
					className: 'dshp-btn dshp-primary',
					disabled: loading || busy,
					onClick: () => doSave().catch(() => {}),
				}, COPY.save),
			);

			return react.createElement('div', { className: 'dshp-root' }, systemPane, appendPane, hint, foot);
		}

		// ---- plugin registration
		function apply(ctx) {
			ctx.slots.inject('settings.section', () => {
				return ctx.slots.register(
					{
						name: 'settings.section',
						id: 'dsh-prompt',
						order: 25,
						label: 'DSH提示词',
					},
					(props) => react.createElement(PromptPage, props),
				);
			});
		}

		module.exports = {
			name: 'dsh-prompt-control',
			inject: ['slots'],
			apply,
		};
		return module.exports;
	},
});
