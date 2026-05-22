import { defineConfig } from 'vitepress'
import vitepressMermaidConfig from '@unify-js/vitepress-mermaid/config'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  extends: vitepressMermaidConfig,
  title: "RelayClaw",
  description: "RelayClaw 是一个多智能体协作平台，将多个 AI Agent 组织成一个真正的团队。",
  base: '/dive-into-relay-claw/',
  vite: {
    resolve: {
      alias: [
        { find: 'mermaid', replacement: 'mermaid/dist/mermaid.esm.mjs' },
        {
          find: 'cytoscape/dist/cytoscape.umd.js',
          replacement: 'cytoscape/dist/cytoscape.esm.js',
        },
        { find: /^dayjs\/(.*)\.js$/, replacement: 'dayjs/esm/$1' },
      ],
    },
    optimizeDeps: {
      include: ['dayjs', '@braintree/sanitize-url', 'debug', 'cytoscape', 'cytoscape-cose-bilkent'],
    },
  },
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: '使用指南', link: '/usage', activeMatch: '/usage/' },
      { text: '原理解析', link: '/tech', activeMatch: '/tech/' }
    ],

    sidebar: {
      '/usage/': [
        {
          text: '使用指南',
          items: [
            { text: '概览', link: '/usage' }
          ]
        }
      ],
      '/tech/': [
        {
          text: '对话',
          items: [
            { text: '整体流程', link: '/tech/chat/overview' },
            { text: '组件树', link: '/tech/chat/component-tree' },
            { text: '数据流', link: '/tech/chat/data-flow' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/kagol/dive-into-relay-claw' }
    ]
  }
})
