'use strict';
/**
 * Catálogo de produtos e order bumps — cópia fiel do catálogo do site
 * (mesmos ids, mesmos preços, mesmas imagens), com o nome da marca trocado
 * apenas onde o texto original citava a marca antiga.
 *
 * A API devolve um ARRAY puro, exatamente como o frontend espera em
 * GET /api/products.
 */
const PRODUCTS = [
  {
    id: 'seguro-basico',
    kind: 'product',
    name: 'Seguro Prestamista Básico',
    gatewayName: 'Depósito 1',
    category: 'Seguro',
    description: 'Cobertura padrão do empréstimo',
    price: 16,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/zVHhnDZk/stellanz.webp',
    sortOrder: 0,
  },
  {
    id: 'seguro-plus',
    kind: 'product',
    name: 'Seguro Prestamista Plus',
    gatewayName: 'Depósito 1 V2',
    category: 'Seguro',
    description: 'Cobertura ampliada: +R$ 2.000 de proteção',
    price: 29,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/zVHhnDZk/stellanz.webp',
    sortOrder: 1,
  },
  {
    id: 'seguro-premium',
    kind: 'product',
    name: 'Seguro Prestamista Premium',
    gatewayName: 'Depósito 1 V3',
    category: 'Seguro',
    description: 'Cobertura máxima: +R$ 6.000 de proteção',
    price: 45,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/zVHhnDZk/stellanz.webp',
    sortOrder: 2,
  },
  {
    id: 'iof',
    kind: 'product',
    name: 'IOF (Imposto sobre Operações Financeiras)',
    gatewayName: 'Depósito 2',
    category: 'Tributo',
    description: 'Tributo federal obrigatório',
    price: 19,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/DgrCw73h/iof.jpg',
    sortOrder: 3,
  },
  {
    id: 'tarifa-cadastro',
    kind: 'product',
    name: 'Tarifa de Cadastro',
    gatewayName: 'Depósito 3',
    category: 'Tarifa',
    description: 'Abertura e análise do cadastro',
    price: 14,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/0yr80Gyk/loan.jpg',
    sortOrder: 4,
  },
  {
    id: 'taxa-app',
    kind: 'product',
    name: 'Tarifa de Liberação do App',
    gatewayName: 'Depósito 4',
    category: 'Tarifa',
    description: 'Liberação do app, 100% reembolsável',
    price: 17,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/pBcZNmpG/app.jpg',
    sortOrder: 5,
  },
  {
    id: 'aumento-limite',
    kind: 'product',
    name: 'Aumento de Limite',
    gatewayName: 'Depósito 5',
    category: 'Upsell',
    description: '+R$ 2.000 de limite disponível',
    price: 18,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/Hp1xBH2D/graph.jpg',
    sortOrder: 6,
  },
  {
    id: 'tarifa-prioridade',
    kind: 'product',
    name: 'Tarifa de Prioridade na Fila',
    gatewayName: 'Depósito 6',
    category: 'Upsell',
    description: 'Receba na frente da fila',
    price: 11,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/PsMnXTHM/up.png',
    sortOrder: 7,
  },
  {
    id: 'taxa-protecao',
    kind: 'product',
    name: 'Transferência Protegida',
    gatewayName: 'Depósito 7',
    category: 'Tarifa',
    description: 'Libera a transferência recusada',
    price: 65,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/KxrfTkxp/shield.jpg',
    sortOrder: 8,
  },
  {
    id: 'bump-suporte',
    kind: 'order_bump',
    name: 'Suporte Exclusivo 24h',
    gatewayName: 'Depósito 8',
    category: 'Order bump',
    description: 'Atendimento prioritário 24h/7d no WhatsApp',
    price: 9,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/MycKsGyC/vip.jpg',
    sortOrder: 100,
  },
  {
    id: 'bump-credito',
    kind: 'order_bump',
    name: 'Aumento de Crédito +R$ 5.000',
    gatewayName: 'Depósito 9',
    category: 'Order bump',
    description: '+R$ 5.000 a mais direto na sua conta',
    price: 22,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/Q38ntgsY/6475919.webp',
    sortOrder: 101,
  },
  {
    id: 'bump-cartao',
    kind: 'order_bump',
    name: 'Cartão de Crédito Valore',
    gatewayName: 'Depósito 10',
    category: 'Order bump',
    description: 'Limite de R$ 2.000, sem anuidade no 1º ano',
    price: 19,
    unit: 'BRL',
    imageUrl: 'https://i.ibb.co/G4WDVK89/6963703.webp',
    sortOrder: 102,
  },
];

const all = () => [...PRODUCTS].sort((a, b) => a.sortOrder - b.sortOrder);
const find = (id) => PRODUCTS.find((p) => p.id === id) || null;

/** Itens da ordem: produto principal + bumps escolhidos (sem repetir). */
function resolveItems(productId, bumpIds = []) {
  const items = [];
  const product = find(productId);
  if (product) items.push({ ...product });
  for (const id of bumpIds || []) {
    const b = find(id);
    if (b && !items.some((i) => i.id === b.id)) items.push({ ...b });
  }
  return items;
}

const totalOf = (items) => Number(items.reduce((s, i) => s + Number(i.price || 0), 0).toFixed(2));

module.exports = { PRODUCTS, all, find, resolveItems, totalOf };
