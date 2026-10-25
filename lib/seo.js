'use strict';

/**
 * Valore Brasil — Definições de Títulos SEO e Metadados Centralizados.
 *
 * Módulo de código-fonte primário para governança de títulos e metadados,
 * utilizado no backend (server.js para carregamento direto) e sincronizado
 * no frontend (index.html e bundles SPA).
 */

const BASE_URL = 'https://www.valorebrasil.app';

const ROUTES_META = {
  '/': {
    title: 'Empréstimo Pessoal Online e Simulação de Crédito | Valore Brasil',
    description: 'Simule seu empréstimo pessoal online de forma rápida, segura e transparente. Conheça as opções e prazos disponíveis na Valore Brasil.',
    indexable: true,
  },
  '/valor': {
    title: 'Simulação de Empréstimo e Parcelas | Valore Brasil',
    description: 'Escolha o valor e a quantidade de parcelas ideais para seu planejamento financeiro com simulação transparente e sem compromisso.',
    indexable: true,
  },
  '/privacidade': {
    title: 'Política de Privacidade e Proteção de Dados | Valore Brasil',
    description: 'Conheça a Política de Privacidade da Valore Brasil e como seus dados são protegidos em total conformidade com a LGPD.',
    indexable: true,
  },
  '/termos': {
    title: 'Termos e Condições Gerais de Uso | Valore Brasil',
    description: 'Leia os termos gerais de uso e as condições para utilização dos serviços de simulação e crédito da Valore Brasil.',
    indexable: true,
  },
  '/cpf': {
    title: 'Identificação e Consulta de Crédito | Valore Brasil',
    description: 'Informe seu CPF com segurança para verificar as opções de crédito pessoal disponíveis para seu perfil.',
    indexable: false,
  },
  '/confirmacao': {
    title: 'Confirmação de Dados Cadastrais | Valore Brasil',
    description: 'Confirme suas informações cadastrais para dar andamento à sua solicitação de crédito.',
    indexable: false,
  },
  '/dados': {
    title: 'Dados de Contato e Acesso | Valore Brasil',
    description: 'Informe seus canais de contato e crie sua senha de segurança para gerenciar sua solicitação.',
    indexable: false,
  },
  '/renda': {
    title: 'Informações de Renda e Ocupação | Valore Brasil',
    description: 'Informe sua ocupação profissional e renda média mensal para adequação do seu plano financeiro.',
    indexable: false,
  },
  '/analise': {
    title: 'Análise da Solicitação de Crédito | Valore Brasil',
    description: 'Aguarde a análise cadastral e verificação de condições personalizadas para sua proposta.',
    indexable: false,
  },
  '/push': {
    title: 'Notificações da Solicitação | Valore Brasil',
    description: 'Ative as notificações para acompanhar o andamento da sua solicitação em tempo real.',
    indexable: false,
  },
  '/aprovacao': {
    title: 'Condições da Proposta de Crédito | Valore Brasil',
    description: 'Consulte as condições simuladas e detalhes disponíveis para sua proposta de crédito pessoal.',
    indexable: false,
  },
  '/dia': {
    title: 'Vencimento das Parcelas | Valore Brasil',
    description: 'Defina o melhor dia do mês para o pagamento das parcelas do seu crédito.',
    indexable: false,
  },
  '/endereco': {
    title: 'Endereço Residencial do Titular | Valore Brasil',
    description: 'Preencha seu endereço residencial para formalização cadastral da sua solicitação.',
    indexable: false,
  },
  '/contrato': {
    title: 'Revisão Contratual da Proposta | Valore Brasil',
    description: 'Revise os termos e condições da Cédula de Crédito Bancário da sua solicitação.',
    indexable: false,
  },
  '/conta': {
    title: 'Dados Bancários para Recebimento | Valore Brasil',
    description: 'Informe os dados da conta bancária de sua titularidade para recebimento da transferência.',
    indexable: false,
  },
  '/abrindo': {
    title: 'Abertura da Conta Digital | Valore Brasil',
    description: 'Aguarde a abertura e ativação da sua conta digital para movimentação dos recursos.',
    indexable: false,
  },
  '/digital': {
    title: 'Conta Digital da Operação | Valore Brasil',
    description: 'Acesse a conta digital vinculada para consultar informações da sua operação.',
    indexable: false,
  },
  '/seguro': {
    title: 'Proteção Financeira e Seguro Prestamista | Valore Brasil',
    description: 'Conheça os benefícios da cobertura do seguro prestamista para sua operação de crédito.',
    indexable: false,
  },
  '/checkout': {
    title: 'Pagamento da Solicitação via PIX | Valore Brasil',
    description: 'Instruções para realização do pagamento seguro via PIX da sua solicitação.',
    indexable: false,
  },
  '/pagamento': {
    title: 'Status do Pagamento da Solicitação | Valore Brasil',
    description: 'Acompanhe o processamento e a verificação do pagamento da sua solicitação.',
    indexable: false,
  },
  '/iof': {
    title: 'Regularização de IOF Regulamentar | Valore Brasil',
    description: 'Informações para recolhimento e regularização do IOF sobre a operação financeira.',
    indexable: false,
  },
  '/tarifa': {
    title: 'Tarifa de Cadastro e Registro | Valore Brasil',
    description: 'Processamento de taxas cadastrais e custos operacionais de emissão de crédito.',
    indexable: false,
  },
  '/download': {
    title: 'Download de Documentos e Aplicativo | Valore Brasil',
    description: 'Baixe os comprovantes da sua operação e o aplicativo oficial para acompanhamento.',
    indexable: false,
  },
  '/taxa-app': {
    title: 'Ativação de Dispositivo e Aplicativo | Valore Brasil',
    description: 'Efetue a ativação do aplicativo oficial para acesso seguro aos serviços da Valore Brasil.',
    indexable: false,
  },
  '/limite': {
    title: 'Consulta de Opção de Limite Adicional | Valore Brasil',
    description: 'Verifique a disponibilidade de ajuste de limite para sua operação.',
    indexable: false,
  },
  '/assinatura': {
    title: 'Assinatura Eletrônica do Termo | Valore Brasil',
    description: 'Formalize a assinatura eletrônica do seu contrato com validade jurídica e segurança.',
    indexable: false,
  },
  '/resumo': {
    title: 'Resumo Consolidado da Operação | Valore Brasil',
    description: 'Revise o resumo completo da sua operação antes da efetivação da transferência.',
    indexable: false,
  },
  '/processando': {
    title: 'Processamento da Transferência | Valore Brasil',
    description: 'Acompanhe o processamento da transferência junto ao sistema financeiro.',
    indexable: false,
  },
  '/fila': {
    title: 'Fila de Processamento Bancário | Valore Brasil',
    description: 'Acompanhe o andamento da sua solicitação na fila de processamento bancário.',
    indexable: false,
  },
  '/validacao': {
    title: 'Validação Cadastral no SFN | Valore Brasil',
    description: 'Validação de dados do beneficiário junto à rede do Sistema Financeiro Nacional.',
    indexable: false,
  },
  '/validado': {
    title: 'Etapa de Validação de Transferência | Valore Brasil',
    description: 'Acompanhe a etapa de validação cadastral para liquidação da transferência.',
    indexable: false,
  },
  '/reprocessando': {
    title: 'Acompanhamento de Nova Tentativa de Envio | Valore Brasil',
    description: 'Acompanhe a nova tentativa de envio da transferência bancária.',
    indexable: false,
  },
  '/recusada': {
    title: 'Aviso de Inconsistência Cadastral | Valore Brasil',
    description: 'Orientações e procedimentos em caso de divergência nos dados informados.',
    indexable: false,
  },
  '/estorno': {
    title: 'Solicitação de Estorno de Tarifas | Valore Brasil',
    description: 'Instruções para processamento e solicitação de estorno de tarifas operacionais.',
    indexable: false,
  },
  '/retomar': {
    title: 'Retomada de Proposta de Crédito | Valore Brasil',
    description: 'Recupere sua solicitação de crédito em andamento e continue de onde parou.',
    indexable: false,
  },
  '/ativar-push': {
    title: 'Ativação de Notificações | Valore Brasil',
    description: 'Habilite notificações web push para receber alertas do sistema no seu navegador.',
    indexable: false,
  },
};

function getRouteMeta(pathname) {
  let path = String(pathname || '/').split('?')[0].split('#')[0].trim();
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  if (ROUTES_META[path]) {
    const item = ROUTES_META[path];
    return {
      path,
      title: item.title,
      description: item.description,
      indexable: item.indexable,
      canonical: item.indexable ? `${BASE_URL}${path === '/' ? '/' : path}` : null,
    };
  }

  if (path.startsWith('/recuperar/') || path === '/recuperar') {
    return {
      path,
      title: 'Recuperação de Solicitação | Valore Brasil',
      description: 'Restaure os dados da sua proposta de crédito pessoal com segurança na Valore Brasil.',
      indexable: false,
      canonical: null,
    };
  }

  if (path.startsWith('/p/') || path === '/p' || path.startsWith('/dash')) {
    const sub = path.replace(/^\/p\/[^/]+/, '');
    let adminTitle = 'Painel de Administração | Valore Brasil';
    if (sub.startsWith('/usuarios')) adminTitle = 'Usuários | Painel Valore Brasil';
    else if (sub.startsWith('/produtos')) adminTitle = 'Produtos e Tarifas | Painel Valore Brasil';
    else if (sub.startsWith('/push')) adminTitle = 'Disparos de Push | Painel Valore Brasil';
    else if (sub.startsWith('/integracoes')) adminTitle = 'Integrações | Painel Valore Brasil';
    else if (sub.startsWith('/gateway')) adminTitle = 'Gateways de Pagamento | Painel Valore Brasil';
    else if (sub.startsWith('/payzu')) adminTitle = 'PayZu Gateway | Painel Valore Brasil';
    else if (sub.startsWith('/consulta-cpf')) adminTitle = 'Consulta de CPF | Painel Valore Brasil';
    else if (sub.startsWith('/seguranca')) adminTitle = 'Segurança e Acessos | Painel Valore Brasil';

    return {
      path,
      title: adminTitle,
      description: 'Área restrita de gestão e controle administrativo da plataforma Valore Brasil.',
      indexable: false,
      canonical: null,
    };
  }

  return {
    path,
    title: 'Página Não Encontrada (404) | Valore Brasil',
    description: 'A página solicitada não foi encontrada na plataforma Valore Brasil.',
    indexable: false,
    canonical: null,
  };
}

/**
 * Injeta metadados de SEO estáticos no HTML inicial no carregamento direto.
 * Garante que robôs e navegadores recebam os títulos e noindex corretos antes do JS.
 */
function injectSeoIntoHtml(html, pathname) {
  const meta = getRouteMeta(pathname);
  let res = html;

  // Substitui <title>
  res = res.replace(/<title>[\s\S]*?<\/title>/i, `<title>${meta.title}</title>`);

  // Substitui ou injeta meta description
  const descTag = `<meta name="description" content="${meta.description.replace(/"/g, '&quot;')}" />`;
  if (/<meta\s+name=["']description["']/i.test(res)) {
    res = res.replace(/<meta\s+name=["']description["'][^>]*>/i, descTag);
  }

  // Substitui ou injeta meta robots
  const robotsTag = `<meta name="robots" content="${meta.indexable ? 'index, follow' : 'noindex, nofollow'}" />`;
  if (/<meta\s+name=["']robots["']/i.test(res)) {
    res = res.replace(/<meta\s+name=["']robots["'][^>]*>/i, robotsTag);
  }

  // Open Graph e Twitter
  if (/<meta\s+property=["']og:title["']/i.test(res)) {
    res = res.replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${meta.title.replace(/"/g, '&quot;')}" />`);
  }
  if (/<meta\s+property=["']og:description["']/i.test(res)) {
    res = res.replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${meta.description.replace(/"/g, '&quot;')}" />`);
  }
  if (/<meta\s+name=["']twitter:title["']/i.test(res)) {
    res = res.replace(/<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${meta.title.replace(/"/g, '&quot;')}" />`);
  }
  if (/<meta\s+name=["']twitter:description["']/i.test(res)) {
    res = res.replace(/<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${meta.description.replace(/"/g, '&quot;')}" />`);
  }

  // Canonical: Apenas se indexável, removendo conflito em noindex
  if (meta.indexable && meta.canonical) {
    const canonicalTag = `<link rel="canonical" href="${meta.canonical}" />`;
    if (/<link\s+rel=["']canonical["']/i.test(res)) {
      res = res.replace(/<link\s+rel=["']canonical["'][^>]*>/i, canonicalTag);
    } else {
      res = res.replace('</head>', `    ${canonicalTag}\n  </head>`);
    }
  } else {
    // Remove link canonical para rotas noindex (evita conflitos de sinal de indexação)
    res = res.replace(/<link\s+rel=["']canonical["'][^>]*>\s*/gi, '');
  }

  return res;
}

module.exports = {
  BASE_URL,
  ROUTES_META,
  getRouteMeta,
  injectSeoIntoHtml,
};
