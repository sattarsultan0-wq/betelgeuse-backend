import { modelConfigs } from '../config/modelCatalog.js';
import { AppError } from '../middleware/errors.js';

export function validateModelInput(body, { estimate = false } = {}) {
  const model = modelConfigs.find((item) => item.id === body.model);
  if (!model?.enabled) throw new AppError(400, 'Эта модель пока недоступна');
  const caps = model.modes[body.mode];
  if (!caps) throw new AppError(400, 'Режим не поддерживается моделью');
  if (
    !estimate &&
    (body.prompt?.trim().length < (caps.promptMin || 1) ||
      !body.prompt?.trim() ||
      body.prompt.length > 2000)
  )
    throw new AppError(400, `Требуется промпт от ${caps.promptMin || 1} до 2000 символов`);
  for (const [key, values] of [
    ['duration', caps.durations],
    ['quality', caps.qualities],
    ['aspectRatio', caps.aspectRatios],
  ]) {
    // Empty persisted placeholders are used by the legacy non-null database columns only.
    if (
      values.length
        ? !values.includes(body[key])
        : body[key] !== undefined && body[key] !== '' && body[key] !== 0
    )
      throw new AppError(400, 'Выбранные параметры не поддерживаются моделью');
  }
  const parameters = body.parameters || {};
  for (const [key, value] of Object.entries(parameters)) {
    const definition = Object.hasOwn(caps.parameters || {}, key) ? caps.parameters[key] : null;
    if (
      !definition ||
      (definition.type === 'boolean'
        ? typeof value !== 'boolean'
        : !definition.values.includes(value))
    )
      throw new AppError(400, 'Дополнительный параметр не поддерживается моделью');
  }
  const references = body.references || [];
  if (body.sourceImageId && !['kling', 'higgsfield'].includes(body.model))
    throw new AppError(400, 'Для этой модели используйте references');
  if (body.sourceImageId && references.length)
    throw new AppError(400, 'Используйте один формат референсов');
  if (!body.trendId && body.sourceImageIds?.length)
    throw new AppError(400, 'Некорректный формат референсов');
  if (references.some((ref) => !caps.references?.some((rule) => rule.role === ref.role)))
    throw new AppError(400, 'Тип референса не поддерживается');
  if (!estimate && !body.trendId) {
    for (const rule of caps.references || []) {
      const count =
        references.filter((ref) => ref.role === rule.role).length +
        (rule.role === 'image' && body.sourceImageId ? 1 : 0);
      if (count < rule.min || count > rule.max)
        throw new AppError(400, `Референс «${rule.label}»: от ${rule.min} до ${rule.max}`);
    }
    if (body.sourceImageId && !caps.references?.some((rule) => rule.role === 'image'))
      throw new AppError(400, 'Изображение не поддерживается текстовым режимом');
    const ids = references.map((ref) => ref.uploadId);
    if (new Set(ids).size !== ids.length) throw new AppError(400, 'Референсы должны быть разными');
  }
  return { model, caps };
}
