// One presentation catalog for GET /api/trends and local video preparation.
// Credentials and generation prompts belong only in backend generation configuration.
// Workspace Trends uses remote HTTPS videos; local examples stay on the homepage.
export const showcaseMedia = [
  {
    id: 'orbit',
    trendId: 'litvin',
    title: 'Популярный тренд с Литвином, Равшаном и Адель.',
    model: 'Авторский концепт',
    sourceVideo: '/videos/litvin.mp4',
    src: 'https://pub-66fef0903f9846c3b025fdfbd4672b02.r2.dev/litvin.mp4',
    poster: '/images/video-posters/litvin.webp',
  },
  {
    id: 'liquid',
    title: 'Жидкая геометрия',
    model: 'Авторский концепт',
    sourceVideo: '/videos/example4.mp4',
    src: 'https://pub-66fef0903f9846c3b025fdfbd4672b02.r2.dev/example4.mp4',
    poster: '/images/video-posters/example4.webp',
  },
  {
    id: 'landscape',
    title: 'Неземная тишина',
    model: 'Авторский концепт',
    sourceVideo: '/videos/example1.mp4',
    src: '/videos/optimized/example1.mp4',
    poster: '/images/video-posters/example1.webp',
  },
  {
    id: 'portal',
    title: 'Другая реальность',
    model: 'Авторский концепт',
    sourceVideo: '/videos/example2.mp4',
    src: '/videos/optimized/example2.mp4',
    poster: '/images/video-posters/example2.webp',
  },
  {
    id: 'waves',
    title: 'Гравитация света',
    model: 'Авторский концепт',
    sourceVideo: '/videos/example3.mp4',
    src: '/videos/optimized/example3.mp4',
    poster: '/images/video-posters/example3.webp',
  },
  {
    id: 'crystal',
    title: 'Идеальная форма',
    model: 'Авторский концепт',
    sourceVideo: '/videos/example5.mp4',
    src: '/videos/optimized/example5.mp4',
    poster: '/images/video-posters/example5.webp',
  },
];
