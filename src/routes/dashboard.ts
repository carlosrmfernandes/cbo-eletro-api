import { Router } from 'express';
import { getPool, sql } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const dashboardRouter = Router();

// Códigos de PEDIDO_MATERIAIS_CLIENTE.APROVACAO (descrições em STATUS_APROVACOES_BASE).
const STATUS = {
  aguardandoDevolucao: { id: 502, nome: 'Aguardando Devolução' },
  aguardandoReversa: { id: 513, nome: 'Aguardando Reversa' },
  aguardandoRetirada: { id: 14, nome: 'Aguardando Retirada' },
} as const;

type Chave = keyof typeof STATUS;
const entries = Object.entries(STATUS) as [Chave, (typeof STATUS)[Chave]][];
const chavePorId = new Map<number, Chave>(entries.map(([chave, s]) => [s.id, chave]));
const IDS = entries.map(([, s]) => s.id).join(', ');

// Mesmo critério da tela de pedidos do sistema com o filtro "Faturados":
// a tabela tem uma linha por pedido, e POSICAO = 'EMITIDO' são os faturados.
const FILTRO = `
FROM dbo.PEDIDO_MATERIAIS_CLIENTE AS pc
WHERE pc.APROVACAO IN (${IDS})
  AND pc.POSICAO = 'EMITIDO'`;

// O marketplace do pedido fica em VENDEDOR ('SHOPEE', 'TIKTOK').
const CANAL = `RTRIM(pc.VENDEDOR)`;
const CANAIS = ['SHOPEE', 'TIKTOK'];

const RESUMO_SQL = `
SELECT pc.APROVACAO, ${CANAL} AS CANAL, COUNT(*) AS PEDIDOS
${FILTRO}
GROUP BY pc.APROVACAO, ${CANAL};
`;

// Card FC82: filtros "Período de Emissão" (mês atual) + "Faturados" + "Entregas Pendentes"
// + Cód. SRO = FC82 da tela de pedidos. Entrega pendente = pedido ainda sem data de entrega.
// Sem o período, entram pedidos antigos que o F8 do pessoal não atualiza mais.
const FC82_SQL = `
SELECT ${CANAL} AS CANAL, COUNT(*) AS PEDIDOS
FROM dbo.PEDIDO_MATERIAIS_CLIENTE AS pc
WHERE pc.POSICAO = 'EMITIDO'
  AND pc.CODSRO = 'FC82'
  AND pc.DTENTREGUE IS NULL
  AND pc.NF_EMISSAO >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
GROUP BY ${CANAL};
`;

// Agrupa pelo mês da data do pedido.
const MENSAL_SQL = `
SELECT CONVERT(char(7), pc.DATA, 120) AS MES, pc.APROVACAO, COUNT(*) AS PEDIDOS
${FILTRO}
  AND pc.DATA IS NOT NULL
GROUP BY CONVERT(char(7), pc.DATA, 120), pc.APROVACAO;
`;

const zerado = (): Record<Chave, number> => ({ aguardandoDevolucao: 0, aguardandoReversa: 0, aguardandoRetirada: 0 });

type Linha = { CANAL: string | null; PEDIDOS: number };

// Shopee e TikTok sempre aparecem (mesmo zerados); qualquer outro vendedor aparece com o próprio nome.
function porCanal(linhas: Linha[]) {
  const totais = new Map<string, number>(CANAIS.map((c) => [c, 0]));
  for (const l of linhas) {
    const canal = l.CANAL?.trim().toUpperCase() || 'SEM VENDEDOR';
    totais.set(canal, (totais.get(canal) ?? 0) + l.PEDIDOS);
  }
  const canais = [...totais].map(([canal, total]) => ({ canal, total }));
  return { total: canais.reduce((s, c) => s + c.total, 0), canais };
}

dashboardRouter.get('/resumo', requireAuth, async (_req, res, next) => {
  try {
    const pool = await getPool();
    const [resumo, fc82] = await Promise.all([
      pool.request().query(RESUMO_SQL),
      pool.request().query(FC82_SQL),
    ]);
    res.json({
      atualizadoEm: new Date().toISOString(),
      cards: [
        ...entries.map(([chave, s]) => ({
          chave,
          status: s.nome,
          ...porCanal(resumo.recordset.filter((r) => r.APROVACAO === s.id)),
        })),
        { chave: 'fc82', status: 'FC82', ...porCanal(fc82.recordset) },
      ],
    });
  } catch (err) {
    next(err);
  }
});

// Lista de 'YYYY-MM' do primeiro ao último mês, sem buracos.
function mesesEntre(inicio: string, fim: string) {
  const meses: string[] = [];
  let [ano, mes] = inicio.split('-').map(Number);
  const [anoFim, mesFim] = fim.split('-').map(Number);
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    meses.push(`${ano}-${String(mes).padStart(2, '0')}`);
    if (++mes > 12) { mes = 1; ano++; }
  }
  return meses;
}

dashboardRouter.get('/mensal', requireAuth, async (_req, res, next) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(MENSAL_SQL);
    const status = entries.map(([chave, s]) => ({ chave, nome: s.nome }));

    if (!recordset.length) {
      return res.json({ status, meses: [] });
    }

    const porMes = new Map<string, Record<Chave, number>>();
    for (const r of recordset) {
      const linha = porMes.get(r.MES) ?? zerado();
      linha[chavePorId.get(r.APROVACAO)!] = r.PEDIDOS;
      porMes.set(r.MES, linha);
    }

    const chaves = [...porMes.keys()].sort();
    const meses = mesesEntre(chaves[0], chaves[chaves.length - 1]).map((mes) => ({
      mes,
      ...(porMes.get(mes) ?? zerado()),
    }));

    res.json({ status, meses });
  } catch (err) {
    next(err);
  }
});

// Lista dos pedidos de um status com os campos mais úteis do pedido e os dados do cliente
// (GESTOR_CLIENTE). A ordem e os títulos das colunas vêm daqui; a tela só desenha.
const COLUNAS = [
  { campo: 'PEDIDO', titulo: 'Pedido' },
  { campo: 'DATA', titulo: 'Data', tipo: 'data' },
  { campo: 'MARKETPLACE', titulo: 'Marketplace' },
  { campo: 'SEUPEDIDO', titulo: 'Pedido marketplace' },
  { campo: 'CLIENTE', titulo: 'Cliente' },
  { campo: 'CPF_CNPJ', titulo: 'CPF/CNPJ' },
  { campo: 'TELEFONE', titulo: 'Telefone' },
  { campo: 'EMAIL', titulo: 'E-mail' },
  { campo: 'CIDADE', titulo: 'Cidade' },
  { campo: 'UF', titulo: 'UF' },
  { campo: 'ENDERECO', titulo: 'Endereço' },
  { campo: 'BAIRRO', titulo: 'Bairro' },
  { campo: 'CEP', titulo: 'CEP' },
  { campo: 'COD_RASTREAMENTO', titulo: 'Rastreio' },
  { campo: 'CODSRO', titulo: 'Cód. SRO' },
  { campo: 'PLP', titulo: 'PLP' },
  { campo: 'NF', titulo: 'NF' },
  { campo: 'NF_EMISSAO', titulo: 'Emissão NF', tipo: 'data' },
  { campo: 'TOTAL_PEDIDO', titulo: 'Valor', tipo: 'moeda' },
  { campo: 'VLRFRETE', titulo: 'Frete', tipo: 'moeda' },
  { campo: 'STATUS', titulo: 'Status' },
  { campo: 'COD_CLIENTE', titulo: 'Cód. cliente' },
];

const PEDIDOS_SQL = `
SELECT pc.PEDIDO, pc.DATA, RTRIM(pc.VENDEDOR) AS MARKETPLACE, pc.SEUPEDIDO,
       g.NOME AS CLIENTE, g.CPF_CNPJ, g.TEL1 AS TELEFONE, g.EMAIL, g.CIDADE, g.UF,
       CONCAT_WS(', ', NULLIF(RTRIM(g.ENDERECO), ''), NULLIF(g.ENDERECO_NUM, 0), NULLIF(RTRIM(g.ENDERECO_COMPL), '')) AS ENDERECO,
       g.BAIRRO, g.CEP,
       pc.COD_RASTREAMENTO, pc.CODSRO, pc.PLP, pc.NF, pc.NF_EMISSAO, pc.TOTAL_PEDIDO, pc.VLRFRETE,
       RTRIM(s.DESCRICAO) AS STATUS, pc.COD_CLIENTE
FROM dbo.PEDIDO_MATERIAIS_CLIENTE AS pc
JOIN dbo.STATUS_APROVACOES_BASE AS s ON s.STATUS_ID = pc.APROVACAO
LEFT JOIN dbo.GESTOR_CLIENTE AS g ON g.COD_CLIENTE = pc.COD_CLIENTE
WHERE pc.APROVACAO = @aprovacao
  AND pc.POSICAO = 'EMITIDO'
ORDER BY pc.DATA;
`;

dashboardRouter.get('/pedidos/:chave', requireAuth, async (req, res, next) => {
  try {
    const chave = String(req.params.chave);
    if (!Object.hasOwn(STATUS, chave)) {
      return res.status(404).json({ message: 'Status não encontrado' });
    }
    const status = STATUS[chave as Chave];

    const pool = await getPool();
    const { recordset } = await pool.request().input('aprovacao', sql.Int, status.id).query(PEDIDOS_SQL);

    // Colunas char vêm com espaços à direita.
    const linhas = recordset.map((r) =>
      Object.fromEntries(COLUNAS.map(({ campo }) => [campo, typeof r[campo] === 'string' ? r[campo].trim() : r[campo]])),
    );

    res.json({ chave, status: status.nome, colunas: COLUNAS, linhas });
  } catch (err) {
    next(err);
  }
});
