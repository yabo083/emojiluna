<template>
    <el-dialog
        v-model="visible"
        :title="t('emojiluna.addEmoji')"
        width="550px"
        @close="handleClose"
        class="add-emoji-dialog"
        destroy-on-close
    >
        <div class="dialog-content">
            <!-- Mode Switcher -->
            <div class="mode-switcher">
                <div
                    class="mode-item"
                    :class="{ active: activeTab === 'upload' }"
                    @click="activeTab = 'upload'"
                >
                    <div class="mode-icon-wrapper">
                        <el-icon><UploadFilled /></el-icon>
                    </div>
                    <span>{{ t('emojiluna.uploadFile') }}</span>
                </div>
                <div
                    class="mode-item"
                    :class="{ active: activeTab === 'url' }"
                    @click="activeTab = 'url'"
                >
                    <div class="mode-icon-wrapper">
                        <el-icon><Link /></el-icon>
                    </div>
                    <span>{{ t('emojiluna.addFromUrl') }}</span>
                </div>
            </div>

            <!-- File Upload Mode -->
            <div v-if="activeTab === 'upload'" class="mode-content fade-in">
                <!-- Upload Area -->
                <div class="upload-area-wrapper">
                     <el-upload
                        v-model:file-list="fileList"
                        action="#"
                        list-type="picture-card"
                        :auto-upload="false"
                        multiple
                        accept="image/*"
                        class="custom-uploader"
                    >
                        <div class="upload-trigger-content">
                            <div class="upload-icon-circle">
                                <el-icon><Plus /></el-icon>
                            </div>
                            <div class="upload-text">{{ t('emojiluna.dragOrClick') }}</div>
                        </div>
                    </el-upload>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">{{ t('emojiluna.category') }}</label>
                        <el-select
                            v-model="form.category"
                            :placeholder="t('emojiluna.category')"
                            style="width: 100%"
                            filterable
                            allow-create
                            default-first-option
                        >
                            <el-option
                                v-for="category in categories"
                                :key="category.name"
                                :label="category.name"
                                :value="category.name"
                            />
                        </el-select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">{{ t('emojiluna.tags.default') }}</label>
                        <el-select
                            v-model="form.tags"
                            :placeholder="t('emojiluna.tags.default')"
                            style="width: 100%"
                            multiple
                            filterable
                            allow-create
                            default-first-option
                            collapse-tags
                            collapse-tags-tooltip
                        >
                            <el-option
                                v-for="tag in allTags"
                                :key="tag"
                                :label="tag"
                                :value="tag"
                            />
                        </el-select>
                    </div>
                </div>

                <div class="ai-switch-wrapper" :class="{ active: form.aiAnalysis }">
                    <div class="ai-content">
                        <div class="ai-icon-box">
                            <el-icon><MagicStick /></el-icon>
                        </div>
                        <div class="ai-text">
                            <div class="ai-title">{{ t('emojiluna.aiAnalysis') }}</div>
                            <div class="ai-desc">{{ t('emojiluna.aiAnalysisDesc') }}</div>
                        </div>
                    </div>
                    <el-switch v-model="form.aiAnalysis" />
                </div>
            </div>

            <!-- URL Mode -->
            <div v-else class="mode-content fade-in">
                <div class="form-group">
                    <label class="form-label required">{{ t('emojiluna.imageUrl') }}</label>
                     <el-input
                        v-model="urlForm.url"
                        :placeholder="t('emojiluna.enterImageUrl')"
                        @input="handleUrlChange"
                        clearable
                    >
                        <template #prefix>
                            <el-icon><Link /></el-icon>
                        </template>
                    </el-input>
                </div>

                <!-- Preview -->
                <div class="url-preview-container" :class="{ 'has-image': urlPreview }">
                    <img
                        v-if="urlPreview"
                        :src="urlForm.url"
                        class="preview-image"
                        @error="handleUrlError"
                    />
                    <div v-else class="preview-placeholder">
                        <div class="placeholder-icon">
                            <el-icon><Picture /></el-icon>
                        </div>
                        <span>{{ t('emojiluna.previewArea') }}</span>
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label required">{{ t('emojiluna.emojiName') }}</label>
                    <el-input v-model="urlForm.name" :placeholder="t('emojiluna.enterEmojiName')" />
                </div>

                 <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">{{ t('emojiluna.category') }}</label>
                        <el-select
                            v-model="urlForm.category"
                            :placeholder="t('emojiluna.category')"
                            style="width: 100%"
                            filterable
                            allow-create
                            default-first-option
                        >
                            <el-option
                                v-for="category in categories"
                                :key="category.name"
                                :label="category.name"
                                :value="category.name"
                            />
                        </el-select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">{{ t('emojiluna.tags.default') }}</label>
                        <el-select
                            v-model="urlForm.tags"
                            :placeholder="t('emojiluna.tags.default')"
                            style="width: 100%"
                            multiple
                            filterable
                            allow-create
                            default-first-option
                            collapse-tags
                            collapse-tags-tooltip
                        >
                            <el-option
                                v-for="tag in allTags"
                                :key="tag"
                                :label="tag"
                                :value="tag"
                            />
                        </el-select>
                    </div>
                </div>
            </div>
        </div>

        <template #footer>
            <div class="dialog-footer">
                <el-button @click="handleClose" class="cancel-btn">{{ t('common.cancel') }}</el-button>
                <el-button
                    type="primary"
                    @click="handleSubmit"
                    :loading="loading"
                    :disabled="!canSubmit"
                    class="submit-btn"
                >
                    {{ t('common.add') }}
                </el-button>
            </div>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { send } from '@koishijs/client'
import { ElMessage, type UploadUserFile } from 'element-plus'
import { UploadFilled, Plus, QuestionFilled, Link, MagicStick, Picture } from '@element-plus/icons-vue'
import type { Category, EmojiAddOptions } from 'koishi-plugin-emojiluna'

interface Props {
    modelValue: boolean
    defaultCategory?: string
}

interface Emits {
    (e: 'update:modelValue', value: boolean): void
    (e: 'success'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { t } = useI18n()

const visible = computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value)
})

const activeTab = ref('upload')
const loading = ref(false)
const categories = ref<Category[]>([])
const allTags = ref<string[]>([])
const urlPreview = ref(false)
const fileList = ref<UploadUserFile[]>([])

const form = reactive({
    category: '',
    tags: [] as string[],
    aiAnalysis: true,
})

const urlForm = reactive({
    name: '',
    category: '',
    tags: [] as string[],
    url: ''
})

const canSubmit = computed(() => {
    if (activeTab.value === 'upload') {
        return fileList.value.length > 0
    } else {
        return urlForm.name.trim() && urlForm.url.trim() && urlPreview.value
    }
})

const loadData = async () => {
    try {
        const [categoriesData, tagsData] = await Promise.all([
            send('emojiluna/getCategories'),
            send('emojiluna/getAllTags')
        ])

        categories.value = categoriesData || []
        allTags.value = tagsData || []
    } catch (error) {
        console.error('Failed to load data:', error)
    }
}

const validateUrlForm = () => {
    // 可以添加URL表单验证逻辑
}

const handleUrlChange = () => {
    validateUrlForm()
    checkUrlPreview()
}

const checkUrlPreview = () => {
    if (urlForm.url.trim()) {
        urlPreview.value = true
    } else {
        urlPreview.value = false
    }
}

const handleUrlError = () => {
    urlPreview.value = false
    ElMessage.warning('图片URL无效或无法加载')
}

const handleSubmit = async () => {
    loading.value = true

    try {
        if (activeTab.value === 'upload') {
            await submitFile()
        } else {
            await submitUrl()
        }

        if (activeTab.value === 'upload' && form.aiAnalysis) {
            ElMessage.success('上传成功，AI正在后台分析，请稍后再使用最新分类/标签检索')
        } else {
            ElMessage.success(t('emojiluna.addSuccess'))
        }
        emit('success')
        handleClose()
    } catch (error) {
        console.error('Failed to add emoji:', error)
        ElMessage.error(t('emojiluna.addFailed'))
    } finally {
        loading.value = false
    }
}

const submitFile = async () => {
    if (fileList.value.length === 0) return

    // 1) 先用 Worker 计算采样哈希，做同批内去重，避免重复上传
    try {
        const filesRaw = fileList.value.filter(f => f.raw).map(f => ({
            name: f.name.replace(/\.[^/.]+$/, ''),
            file: f.raw,
            category: form.category || '其他',
            tags: JSON.stringify(form.tags),
            aiAnalysis: form.aiAnalysis
        }))

        // Hash worker: 使用 crypto.subtle.digest 和采样（head/mid/tail）以降低 IO
        const hashWorkerScript = `
        self.onmessage = async (e) => {
            const { files, sampleSize = 10240, concurrency = 4 } = e.data;
            const results = [];
            let idx = 0;

            const readSample = async (file) => {
                const size = file.size;
                const needFull = size <= sampleSize * 3;
                const parts = [];
                if (needFull) {
                    parts.push(await file.arrayBuffer());
                } else {
                    const head = file.slice(0, sampleSize);
                    const tail = file.slice(size - sampleSize, size);
                    const midStart = Math.max(Math.floor(size / 2) - Math.floor(sampleSize / 2), sampleSize);
                    const mid = file.slice(midStart, midStart + sampleSize);
                    parts.push(await head.arrayBuffer());
                    parts.push(await mid.arrayBuffer());
                    parts.push(await tail.arrayBuffer());
                }
                // concat
                let totalLen = 0;
                for (const p of parts) totalLen += p.byteLength;
                const tmp = new Uint8Array(totalLen);
                let offset = 0;
                for (const p of parts) {
                    tmp.set(new Uint8Array(p), offset);
                    offset += p.byteLength;
                }
                const digest = await crypto.subtle.digest('SHA-256', tmp.buffer);
                const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
                return hex;
            };

            const workerLoop = async () => {
                while (true) {
                    const i = idx++;
                    if (i >= files.length) break;
                    const item = files[i];
                    try {
                        const hash = await readSample(item.file);
                        self.postMessage({ type: 'hash', index: i, name: item.name, hash });
                    } catch (err) {
                        self.postMessage({ type: 'error', index: i, name: item.name, error: err.message });
                    }
                }
            };

            const workers = [];
            for (let w = 0; w < Math.min(concurrency, files.length); w++) {
                workers.push(workerLoop());
            }
            await Promise.all(workers);
            self.postMessage({ type: 'done' });
        };
        `

        const hashBlob = new Blob([hashWorkerScript], { type: 'application/javascript' });
        const hashWorkerUrl = URL.createObjectURL(hashBlob);
        const hashWorker = new Worker(hashWorkerUrl);

        const hashes: { index: number; name: string; hash: string }[] = []
        const errors: any[] = []

        const hashPromise = new Promise<void>((resolve, reject) => {
            hashWorker.onmessage = (e) => {
                const data = e.data;
                if (data.type === 'hash') {
                    hashes.push({ index: data.index, name: data.name, hash: data.hash });
                } else if (data.type === 'error') {
                    errors.push({ index: data.index, name: data.name, error: data.error });
                } else if (data.type === 'done') {
                    resolve();
                }
            };
            hashWorker.onerror = (err) => reject(err);
        })

        // Start hashing
        hashWorker.postMessage({ files: filesRaw, sampleSize: 10240, concurrency: 4 });
        await hashPromise;
        hashWorker.terminate();
        URL.revokeObjectURL(hashWorkerUrl);

        if (errors.length > 0) {
            console.warn('Some hash calculations failed:', errors);
        }

        // Deduplicate by hash within this batch
        const seen = new Map<string, number>();
        const uniqueFiles: typeof filesRaw = [];
        const duplicates: string[] = [];
        // Map index -> hash
        const indexHash = new Map<number, string>();
        for (const h of hashes) indexHash.set(h.index, h.hash);

        filesRaw.forEach((item, i) => {
            const hash = indexHash.get(i);
            if (!hash) {
                uniqueFiles.push(item);
                return;
            }
            if (!seen.has(hash)) {
                seen.set(hash, i);
                uniqueFiles.push(item);
            } else {
                duplicates.push(item.name);
            }
        });

        if (duplicates.length > 0) {
            ElMessage.info(`已在本次选择中去重 ${duplicates.length} 个重复文件`) 
        }

        // 2) 准备上传唯一文件，使用原有的 upload worker 机制
        const baseUrl = await send('emojiluna/getBaseUrl')
        let uploadUrl = `${baseUrl}/upload`
        if (!uploadUrl.startsWith('http')) {
            uploadUrl = new URL(uploadUrl, window.location.origin).toString()
        }

        const concurrency = 4 // Browser concurrency for uploads
        const files = uniqueFiles.map(f => ({
            name: f.name,
            category: f.category,
            tags: f.tags,
            aiAnalysis: f.aiAnalysis,
            file: f.file
        }))

        const workerScript = `
        self.onmessage = async (e) => {
            const { files, url, concurrency } = e.data;
            let active = 0;
            let index = 0;
            let completed = 0;
            let errors = [];

            const processNext = async () => {
                if (index >= files.length) return;
                const currentIndex = index++;
                const item = files[currentIndex];
                active++;

                try {
                    const formData = new FormData();
                    formData.append('file', item.file);
                    formData.append('name', item.name);
                    formData.append('category', item.category);
                    formData.append('tags', item.tags);
                    formData.append('aiAnalysis', item.aiAnalysis);

                    const response = await fetch(url, {
                        method: 'POST',
                        body: formData
                    });

                    if (!response.ok) {
                         const text = await response.text();
                         throw new Error(\`Upload failed: \${response.status} \${text}\`);
                    }
                    self.postMessage({ type: 'progress', current: ++completed, total: files.length });
                } catch (err) {
                    errors.push({ file: item.name, error: err.message });
                    console.error(\`Upload error for \${item.name}:\`, err);
                } finally {
                    active--;
                    if (index < files.length) {
                        processNext();
                    } else if (active === 0) {
                        self.postMessage({ type: 'done', errors });
                    }
                }
            };

            for (let i = 0; i < Math.min(concurrency, files.length); i++) {
                processNext();
            }
        };
        `

        const blob = new Blob([workerScript], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);

        return new Promise<void>((resolve, reject) => {
            worker.onmessage = (e) => {
                const { type, current, total, errors } = e.data;
                if (type === 'progress') {
                    // update UI if needed
                } else if (type === 'done') {
                    worker.terminate();
                    URL.revokeObjectURL(workerUrl);
                    if (errors && errors.length > 0) {
                        console.warn('Some uploads failed:', errors);
                        ElMessage.warning(`部分上传失败: ${errors.length} 个文件`);
                    }
                    resolve();
                }
            };

            worker.onerror = (err) => {
                worker.terminate();
                URL.revokeObjectURL(workerUrl);
                reject(err);
            };

            worker.postMessage({ files, url: uploadUrl, concurrency });
        });

    } catch (err) {
        console.error('Upload worker setup failed:', err);
        throw err;
    }
}

const submitUrl = async () => {
    // 从URL下载图片并转换为base64
    const response = await fetch(urlForm.url)
    const buffer = await response.arrayBuffer()
    const uint8Array = new Uint8Array(buffer)
    const base64 = btoa(String.fromCharCode.apply(null, Array.from(uint8Array)))

    const emojiData = {
        name: urlForm.name,
        category: urlForm.category || '其他',
        tags: urlForm.tags,
        imageData: base64,
        mimeType: response.headers.get('content-type') || 'image/png'
    }

    await send('emojiluna/addEmoji', emojiData)
}

const resetForm = () => {
    form.category = ''
    form.tags = []
    form.aiAnalysis = true
    urlForm.name = ''
    urlForm.category = ''
    urlForm.tags = []
    urlForm.url = ''
    fileList.value = []
    urlPreview.value = false
    activeTab.value = 'upload'
}

const handleClose = () => {
    resetForm()
    visible.value = false
}

watch(
    () => props.modelValue,
    (newValue) => {
        if (newValue) {
            loadData()
            // 设置默认分类
            if (props.defaultCategory) {
                form.category = props.defaultCategory
                urlForm.category = props.defaultCategory
            }
        }
    }
)

onMounted(() => {
    loadData()
})
</script>

<style scoped>
.dialog-content {
    padding: 0 4px;
}

/* Mode Switcher */
.mode-switcher {
    display: flex;
    background: var(--k-color-surface-2);
    padding: 4px;
    border-radius: 12px;
    margin-bottom: 24px;
    gap: 4px;
}

.mode-item {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: var(--k-text-light);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    border: 1px solid transparent;
}

.mode-item:hover {
    color: var(--k-color-text);
    background: color-mix(in srgb, var(--k-color-surface-1), transparent 50%);
}

.mode-item.active {
    background: var(--k-color-surface-1);
    color: var(--k-color-primary);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    font-weight: 600;
    border-color: var(--k-color-border);
}

.mode-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
}

/* Upload Styles */
.upload-area-wrapper {
    margin-bottom: 24px;
}

.custom-uploader :deep(.el-upload--picture-card) {
    width: 100%;
    height: 180px; /* Taller */
    border-radius: 16px; /* More rounded */
    border: 2px dashed var(--k-color-divider);
    background: var(--k-color-surface-1);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: hidden;
}

.custom-uploader :deep(.el-upload--picture-card:hover) {
    border-color: var(--k-color-primary);
    background: color-mix(in srgb, var(--k-color-primary), transparent 96%);
}

.upload-trigger-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--k-text-light);
    width: 100%;
    height: 100%;
}

.upload-icon-circle {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--k-color-surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: var(--k-color-primary);
    transition: transform 0.3s ease;
}

.custom-uploader :deep(.el-upload--picture-card:hover) .upload-icon-circle {
    transform: scale(1.1);
    background: var(--k-color-primary);
    color: white;
}

.upload-text {
    font-size: 14px;
    font-weight: 500;
}

/* Form Styles */
.form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 24px;
}

.form-group {
    margin-bottom: 20px;
}

.form-label {
    display: block;
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--k-text-light);
}

.form-label.required::after {
    content: '*';
    color: var(--k-color-danger);
    margin-left: 4px;
}

/* AI Switch */
.ai-switch-wrapper {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--k-color-surface-1);
    padding: 12px 16px;
    border-radius: 12px;
    border: 1px solid var(--k-color-divider);
    transition: all 0.3s ease;
    margin-top: 16px;
}

.ai-switch-wrapper.active {
    border-color: var(--k-color-primary);
    background: color-mix(in srgb, var(--k-color-primary), transparent 97%);
}

.ai-content {
    display: flex;
    align-items: center;
    gap: 12px;
}

.ai-icon-box {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 16px;
    box-shadow: 0 4px 12px rgba(236, 72, 153, 0.2);
}

.ai-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ai-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--k-color-text);
}

.ai-desc {
    font-size: 12px;
    color: var(--k-text-light);
    line-height: 1.2;
}

/* URL Preview */
.url-preview-container {
    width: 100%;
    height: 180px;
    border-radius: 16px;
    background: var(--k-color-surface-1);
    border: 2px dashed var(--k-color-divider);
    margin-bottom: 24px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s ease;
}

.url-preview-container.has-image {
    border-style: solid;
    border-color: var(--k-color-divider);
    background: transparent;
}

.preview-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    padding: 12px;
}

.preview-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: var(--k-text-light);
}

.placeholder-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--k-color-surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
}

/* Footer */
.dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 10px;
}

/* Animations */
.fade-in {
    animation: fadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fadeIn {
    from {
        opacity: 0;
        transform: translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
</style>
