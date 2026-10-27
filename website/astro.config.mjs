// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://fullstackladder.dev',
  base: '/SessionBay',
  integrations: [
    starlight({
      title: 'Session Bay',
      description: 'Find your coding context. Continue your work.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-tw': { label: '繁體中文', lang: 'zh-TW' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/wellwind/SessionBay' }],
      editLink: { baseUrl: 'https://github.com/wellwind/SessionBay/edit/main/website/' },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Guide',
          translations: { 'zh-TW': '使用教學' },
          items: [
            { slug: 'guide/getting-started' },
            { slug: 'guide/install' },
            { slug: 'guide/find-sessions' },
            { slug: 'guide/terminals' },
            { slug: 'guide/agent-status' },
            { slug: 'guide/git' },
            { slug: 'guide/cleanup' },
            { slug: 'guide/settings' },
          ],
        },
        {
          label: 'Reference',
          translations: { 'zh-TW': '參考資料' },
          items: [
            { slug: 'reference/supported-agents' },
            { slug: 'reference/privacy' },
            { slug: 'reference/faq' },
          ],
        },
      ],
    }),
  ],
});
