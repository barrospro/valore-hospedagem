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
    name: 'Seguro Prestamista',
    gatewayName: 'Depósito 1',
    category: 'Seguro',
    description: 'Cobertura padrão do empréstimo (valor simulado integral)',
    price: 16.8,
    unit: 'BRL',
    imageUrl: '/images/seguro-basico.svg',
    sortOrder: 0,
  },
  {
    id: 'seguro-plus',
    kind: 'product',
    name: 'Seguro Prestamista Plus',
    gatewayName: 'Depósito 1 V2',
    category: 'Seguro',
    description: 'Cobertura ampliada: +20% de bônus no saldo',
    price: 26.97,
    unit: 'BRL',
    imageUrl: '/images/seguro-plus.svg',
    sortOrder: 1,
  },
  {
    id: 'seguro-premium',
    kind: 'product',
    name: 'Seguro Prestamista Premium VIP',
    gatewayName: 'Depósito 1 V3',
    category: 'Seguro',
    description: 'Cobertura máxima: +44,9% de bônus no saldo',
    price: 44.7,
    unit: 'BRL',
    imageUrl: '/images/seguro-premium.svg',
    sortOrder: 2,
  },
  {
    id: 'iof',
    kind: 'product',
    name: 'IOF (Imposto sobre Operações Financeiras)',
    gatewayName: 'Depósito 2',
    category: 'Tributo',
    description: 'Tributo federal obrigatório',
    price: 18.2,
    unit: 'BRL',
    imageUrl: '/images/iof.svg',
    sortOrder: 3,
  },
  {
    id: 'tarifa-cadastro',
    kind: 'product',
    name: 'Tarifa de Cadastro',
    gatewayName: 'Depósito 3',
    category: 'Tarifa',
    description: 'Abertura e análise do cadastro',
    price: 14.7,
    unit: 'BRL',
    imageUrl: '/images/tarifa-cadastro.svg',
    sortOrder: 4,
  },
  {
    id: 'taxa-app',
    kind: 'product',
    name: 'Tarifa de Liberação do App',
    gatewayName: 'Depósito 4',
    category: 'Tarifa',
    description: 'Liberação do app, 100% reembolsável',
    price: 16.8,
    unit: 'BRL',
    imageUrl: '/images/taxa-app.svg',
    sortOrder: 5,
  },
  {
    id: 'aumento-limite',
    kind: 'product',
    name: 'Aumento de Limite',
    gatewayName: 'Depósito 5',
    category: 'Upsell',
    description: '+R$ 2.000 de limite disponível',
    price: 17.5,
    unit: 'BRL',
    imageUrl: '/images/aumento-limite.svg',
    sortOrder: 6,
  },
  {
    id: 'tarifa-prioridade',
    kind: 'product',
    name: 'Tarifa de Prioridade na Fila',
    gatewayName: 'Depósito 6',
    category: 'Upsell',
    description: 'Receba na frente da fila',
    price: 12.6,
    unit: 'BRL',
    imageUrl: '/images/tarifa-prioridade.svg',
    sortOrder: 7,
  },
  {
    id: 'taxa-protecao',
    kind: 'product',
    name: 'Transferência Protegida',
    gatewayName: 'Depósito 7',
    category: 'Tarifa',
    description: 'Libera a transferência recusada',
    price: 50.4,
    unit: 'BRL',
    imageUrl: '/images/taxa-protecao.svg',
    sortOrder: 8,
  },
  {
    id: 'bump-suporte',
    kind: 'order_bump',
    name: 'Suporte Exclusivo 24h',
    gatewayName: 'Depósito 8',
    category: 'Order bump',
    description: 'Atendimento prioritário 24h/7d no WhatsApp',
    price: 11.2,
    unit: 'BRL',
    imageUrl: '/images/bump-suporte.svg',
    sortOrder: 100,
  },
  {
    id: 'bump-credito',
    kind: 'order_bump',
    name: 'Aumento de Crédito +R$ 5.000',
    gatewayName: 'Depósito 9',
    category: 'Order bump',
    description: '+R$ 5.000 a mais direto na sua conta',
    price: 20.3,
    unit: 'BRL',
    imageUrl: '/images/bump-credito.svg',
    sortOrder: 101,
  },
  {
    id: 'bump-cartao',
    kind: 'order_bump',
    name: 'Cartão de Crédito Valore',
    gatewayName: 'Depósito 10',
    category: 'Order bump',
    description: 'Limite de R$ 2.000, sem anuidade no 1º ano',
    price: 18.2,
    unit: 'BRL',
    imageUrl: '/images/bump-cartao.svg',
    sortOrder: 102,
  },
  {
    id: 'cartao-credito',
    kind: 'product',
    name: 'Anuidade Cartão de Crédito Valore',
    gatewayName: 'Depósito Cartão',
    category: 'Cartão',
    description: 'Emissão e anuidade do Cartão de Crédito Valore',
    price: 19.9,
    unit: 'BRL',
    imageUrl: '/images/bump-cartao.svg',
    sortOrder: 10,
  },
  {
    id: 'bump-cartao-black',
    kind: 'order_bump',
    name: 'Upgrade Cartão Black (Dobro do Limite)',
    gatewayName: 'Depósito Cartão Black',
    category: 'Order bump',
    description: 'Limite em dobro no Cartão Black exclusivo',
    price: 24.9,
    unit: 'BRL',
    imageUrl: '/images/bump-cartao.svg',
    sortOrder: 103,
  },
  {
    id: 'bump-cartao-sedex',
    kind: 'order_bump',
    name: 'Expedição Expressa 24h & Seguro Total',
    gatewayName: 'Depósito Cartão Sedex',
    category: 'Order bump',
    description: 'Envio prioritário 24h com rastreio no WhatsApp e seguro perda/roubo',
    price: 14.9,
    unit: 'BRL',
    imageUrl: '/images/bump-cartao.svg',
    sortOrder: 104,
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
