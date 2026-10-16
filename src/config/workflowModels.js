// Verified against https://open.higgsfield.ai/models/<workflow>/api-reference,
// 2026-10-16. Deliberately expose a documented subset of optional API features.
const range = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const choice = (label, values, value = values[0]) => ({
  label,
  type: 'select',
  values,
  default: value,
});
const toggle = (label, value) => ({ label, type: 'boolean', default: value });
const reference = (role, label, type, apiField, min = 1, max = 1, array = false) => ({
  role,
  label,
  type,
  apiField,
  min,
  max,
  array,
  mimeTypes: type === 'video' ? ['video/mp4'] : ['image/jpeg', 'image/png', 'image/webp'],
  maxBytes: (type === 'video' ? 50 : 10) * 1024 * 1024,
});
const image = (field = 'image_url', max = 1, array = false) =>
  reference('image', 'Изображение', 'image', field, 1, max, array);
const frames = (first = 'image_url', last = 'end_image_url') => [
  reference('first_frame', 'Первый кадр', 'image', first),
  reference('last_frame', 'Последний кадр', 'image', last),
];
function mode(
  endpoint,
  {
    durations = [],
    qualities = [],
    aspectRatios = [],
    references = [],
    parameters = {},
    fixed = {},
    qualityField = 'resolution',
    promptMin = 1,
  } = {},
) {
  return {
    endpoint,
    method: 'POST',
    durations,
    qualities,
    aspectRatios,
    references,
    parameters,
    fixed,
    qualityField,
    promptMin,
    defaults: {
      ...(durations.length ? { duration: durations.includes(5) ? 5 : durations[0] } : {}),
      ...(qualities.length ? { quality: qualities[0] } : {}),
      ...(aspectRatios.length ? { aspectRatio: aspectRatios[0] } : {}),
    },
  };
}
function model(id, name, generationType, modes) {
  return { id, name, generationType, provider: 'higgsfield', enabled: true, verified: true, modes };
}
const commonRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9'];
const qwen = {
  qualities: ['1k', '2k'],
  aspectRatios: commonRatios,
  fixed: { prompt_extend: true, enable_thinking: true, prompt_extend_mode: 'direct' },
};
const soul = {
  qualities: ['720p', '1080p'],
  aspectRatios: ['4:3', '9:16', '16:9', '3:4', '1:1', '2:3', '3:2'],
  fixed: { batch_size: 1, enhance_prompt: true },
};
const ideogram = {
  promptMin: 2,
  aspectRatios: [
    '1:1',
    '1:2',
    '2:1',
    '2:3',
    '3:2',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '5:8',
    '8:5',
    '3:4',
    '4:3',
    '9:22',
    '22:9',
    '9:23',
    '23:9',
    '3:8',
    '8:3',
    '5:12',
    '12:5',
    '1:3',
    '3:1',
  ],
  parameters: { rendering_speed: choice('Скорость рендера', ['DEFAULT', 'TURBO', 'QUALITY']) },
};
const grok = {
  qualities: ['1k', '2k'],
  aspectRatios: ['auto', '1:1', '1:2', '2:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'],
  parameters: { quality: choice('Детализация', ['medium', 'low']) },
};
const wan = {
  durations: range(2, 30),
  qualities: ['1080p', '720p', '480p'],
  aspectRatios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
  parameters: {
    generate_audio: toggle('Звук', true),
    enable_thinking: toggle('Планирование сцены', false),
  },
};
const seedance = {
  durations: range(4, 30),
  qualities: ['720p', '480p', '1080p'],
  parameters: { generate_audio: toggle('Звук', true) },
  fixed: { output_format: 'mp4' },
};
const o3 = {
  durations: range(3, 15),
  aspectRatios: ['16:9', '9:16', '1:1'],
  parameters: {
    mode: choice('Качество', ['std', 'pro', '4k']),
    sound: choice('Звук', ['off', 'on']),
  },
  fixed: { multi_shots: false },
};
export const workflowModels = [
  model('qwen-image-3', 'Qwen Image 3', 'Image', {
    TEXT_TO_IMAGE: mode('alibaba/qwen-image-3/text-to-image', qwen),
    IMAGE_TO_IMAGE: mode('alibaba/qwen-image-3/edit', {
      ...qwen,
      references: [image('image_urls', 3, true)],
    }),
  }),
  model('soul-v2', 'SOUL V2', 'Image', {
    TEXT_TO_IMAGE: mode('higgsfield-ai/soul/v2/standard', soul),
    IMAGE_TO_IMAGE: mode('higgsfield-ai/soul/v2/image-to-image', {
      ...soul,
      references: [image()],
    }),
  }),
  model('ideogram-4', 'Ideogram 4.0', 'Image', {
    TEXT_TO_IMAGE: mode('ideogram/v4.0', ideogram),
    IMAGE_TO_IMAGE: mode('ideogram/v4.0', { ...ideogram, references: [image()] }),
  }),
  model('recraft-v4-1', 'Recraft V4.1', 'Image', {
    TEXT_TO_IMAGE: mode('recraft/v4.1/text-to-image', {
      qualities: ['1k'],
      aspectRatios: [
        '1:1',
        '2:1',
        '1:2',
        '3:2',
        '2:3',
        '4:3',
        '3:4',
        '5:4',
        '4:5',
        '6:10',
        '14:10',
        '10:14',
        '16:9',
        '9:16',
      ],
      fixed: { output_format: 'png' },
    }),
  }),
  model('grok-image-2', 'Grok Imagine 2.0', 'Image', {
    TEXT_TO_IMAGE: mode('xai/grok-imagine-image-2.0', grok),
    IMAGE_TO_IMAGE: mode('xai/grok-imagine-image-2.0', {
      ...grok,
      references: [image('image_urls', 1, true)],
    }),
  }),
  model('kling-2-5-turbo', 'Kling 2.5 Turbo Pro', 'Video', {
    TEXT_TO_VIDEO: mode('kling-video/v2.5-turbo/pro/text-to-video', {
      durations: [5, 10],
      fixed: { cfg_scale: 0.5 },
    }),
    IMAGE_TO_VIDEO: mode('kling-video/v2.5-turbo/pro/image-to-video', {
      durations: [5, 10],
      references: [image()],
      fixed: { cfg_scale: 0.5 },
    }),
  }),
  model('wan-3', 'Wan 3.0', 'Video', {
    TEXT_TO_VIDEO: mode('alibaba/wan-3.0/text-to-video', wan),
    IMAGE_TO_VIDEO: mode('alibaba/wan-3.0/image-to-video', { ...wan, references: [image()] }),
    FIRST_LAST_FRAME: mode('alibaba/wan-3.0/image-to-video', { ...wan, references: frames() }),
  }),
  model('seedance-2-5', 'Seedance 2.5', 'Video', {
    TEXT_TO_VIDEO: mode('bytedance/seedance-2.5/text-to-video', {
      ...seedance,
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    }),
    IMAGE_TO_VIDEO: mode('bytedance/seedance-2.5/image-to-video', {
      ...seedance,
      references: [image()],
    }),
    FIRST_LAST_FRAME: mode('bytedance/seedance-2.5/image-to-video', {
      ...seedance,
      references: frames(),
    }),
  }),
  model('kling-o3', 'Kling O3', 'Video', {
    FIRST_LAST_FRAME: mode('kling-video/o3/first-last-frame', {
      ...o3,
      references: frames('first_frame_url', 'last_frame_url'),
    }),
    VIDEO_TO_VIDEO: mode('kling-video/o3/video-edit', {
      references: [reference('video', 'Исходное видео', 'video', 'video_urls', 1, 1, true)],
      parameters: { mode: choice('Качество', ['std', 'pro', '4k']) },
    }),
  }),
  model('kling-3-motion', 'Kling 3.0 Motion Control', 'Video', {
    MOTION_CONTROL: mode('kling-video/v3/motion-control/std', {
      references: [image(), reference('video', 'Референс движения', 'video', 'video_url')],
      parameters: {
        keep_original_sound: choice('Исходный звук', ['yes', 'no']),
        character_orientation: choice('Ориентация персонажа', ['video', 'image']),
      },
    }),
  }),
];
