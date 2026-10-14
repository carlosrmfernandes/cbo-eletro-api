import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db.js';
import { pgPool } from '../pg.js';
import { requireAuth } from '../middleware/auth.js';
import { CorreiosError, rastrear } from '../correios.js';

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

// Card FC82: filtros "Faturados" + "Entregas Pendentes" + Cód. SRO = FC82 da tela de pedidos.
// Entrega pendente = POSICAO_ENTREGA diferente de 1 (entregue). DTENTREGUE não serve:
// há pedidos marcados como entregues que ficaram sem a data preenchida.
const FC82_SQL = `
SELECT ${CANAL} AS CANAL, COUNT(*) AS PEDIDOS
FROM dbo.PEDIDO_MATERIAIS_CLIENTE AS pc
WHERE pc.POSICAO = 'EMITIDO'
  AND pc.CODSRO = 'FC82'
  AND pc.POSICAO_ENTREGA <> 1
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
  { campo: 'COD_RASTREAMENTO', titulo: 'Rastreio' },
  { campo: 'OBSERVACAO', titulo: 'Observação', tipo: 'observacao' },
  { campo: 'SEUPEDIDO', titulo: 'Pedido marketplace' },
  { campo: 'CLIENTE', titulo: 'Cliente' },
  { campo: 'CPF_CNPJ', titulo: 'CPF/CNPJ' },
  { campo: 'TELEFONE', titulo: 'Telefone' },
  { campo: 'CIDADE', titulo: 'Cidade' },
  { campo: 'UF', titulo: 'UF' },
  { campo: 'ENDERECO', titulo: 'Endereço' },
  { campo: 'BAIRRO', titulo: 'Bairro' },
  { campo: 'CEP', titulo: 'CEP' },
  { campo: 'CODSRO', titulo: 'Cód. SRO' },
  { campo: 'PLP', titulo: 'PLP' },
  { campo: 'NF', titulo: 'NF' },
  { campo: 'NF_EMISSAO', titulo: 'Emissão NF', tipo: 'data' },
  { campo: 'TOTAL_PEDIDO', titulo: 'Valor', tipo: 'moeda' },
  { campo: 'VLRFRETE', titulo: 'Frete', tipo: 'moeda' },
  { campo: 'STATUS', titulo: 'Status' },
  { campo: 'COD_CLIENTE', titulo: 'Cód. cliente' },
];

// Filtro de cada lista: os status pelo código de APROVACAO; FC82 com o mesmo critério do card.
const FILTROS_LISTA: Record<string, { nome: string; where: string }> = {
  ...Object.fromEntries(entries.map(([chave, s]) => [chave, { nome: s.nome, where: `pc.APROVACAO = ${s.id} AND pc.POSICAO = 'EMITIDO'` }])),
  fc82: { nome: 'FC82', where: `pc.POSICAO = 'EMITIDO' AND pc.CODSRO = 'FC82' AND pc.POSICAO_ENTREGA <> 1` },
};

const pedidosSql = (where: string) => `
SELECT pc.PEDIDO, pc.DATA, RTRIM(pc.VENDEDOR) AS MARKETPLACE, pc.SEUPEDIDO,
       g.NOME AS CLIENTE, g.CPF_CNPJ, g.TEL1 AS TELEFONE, g.CIDADE, g.UF,
       CONCAT_WS(', ', NULLIF(RTRIM(g.ENDERECO), ''), NULLIF(g.ENDERECO_NUM, 0), NULLIF(RTRIM(g.ENDERECO_COMPL), '')) AS ENDERECO,
       g.BAIRRO, g.CEP,
       pc.COD_RASTREAMENTO, pc.CODSRO, pc.PLP, pc.NF, pc.NF_EMISSAO, pc.TOTAL_PEDIDO, pc.VLRFRETE,
       RTRIM(s.DESCRICAO) AS STATUS, pc.COD_CLIENTE
FROM dbo.PEDIDO_MATERIAIS_CLIENTE AS pc
JOIN dbo.STATUS_APROVACOES_BASE AS s ON s.STATUS_ID = pc.APROVACAO
LEFT JOIN dbo.GESTOR_CLIENTE AS g ON g.COD_CLIENTE = pc.COD_CLIENTE
WHERE ${where}
ORDER BY pc.DATA;
`;

// Colunas que o usuário escondeu na lista de pedidos (vale para todos os status).
// Guarda as ocultas, e não as visíveis, para que uma coluna nova apareça sem ninguém precisar marcar.
const PREF_COLUNAS = 'pedidos.colunasOcultas';

async function colunasOcultas(userId: number): Promise<string[]> {
  const { rows } = await pgPool.query<{ value: string[] }>(
    `SELECT "value" FROM "UserPreference" WHERE "userId" = $1 AND "key" = $2`,
    [userId, PREF_COLUNAS],
  );
  return rows[0]?.value ?? [];
}

// Observações vêm do Postgres (o SQL Server é só leitura) e entram na linha pelo número do pedido.
interface Observacao {
  texto: string;
  por: string | null;
  em: string;
}

async function observacoes(pedidos: string[]) {
  const { rows } = await pgPool.query<{ pedido: string } & Observacao>(
    `SELECT o."pedido", o."texto", u."name" AS por, o."updatedAt" AS em
     FROM "PedidoObservacao" o
     LEFT JOIN "User" u ON u."id" = o."updatedBy"
     WHERE o."pedido" = ANY($1)`,
    [pedidos],
  );
  return new Map(rows.map(({ pedido, ...o }) => [pedido, o]));
}

const observacaoSchema = z.object({ texto: z.string().trim().max(2000, 'Observação muito longa (máx. 2000 caracteres)') });

// Texto vazio apaga a observação.
dashboardRouter.put('/pedidos/:pedido/observacao', requireAuth, async (req, res, next) => {
  try {
    const pedido = String(req.params.pedido).trim();
    if (!/^[\w-]{1,40}$/.test(pedido)) {
      return res.status(400).json({ message: 'Pedido inválido' });
    }
    const parsed = observacaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const { texto } = parsed.data;

    if (!texto) {
      await pgPool.query(`DELETE FROM "PedidoObservacao" WHERE "pedido" = $1`, [pedido]);
      return res.json({ observacao: null });
    }

    const { rows } = await pgPool.query<{ em: string }>(
      `INSERT INTO "PedidoObservacao" ("pedido", "texto", "updatedBy")
       VALUES ($1, $2, $3)
       ON CONFLICT ("pedido") DO UPDATE SET "texto" = EXCLUDED."texto", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = NOW()
       RETURNING "updatedAt" AS em`,
      [pedido, texto, req.user!.id],
    );
    const observacao: Observacao = { texto, por: req.user!.name, em: rows[0].em };
    res.json({ observacao });
  } catch (err) {
    next(err);
  }
});

const CAMPOS = COLUNAS.map((c) => c.campo) as [string, ...string[]];
const colunasSchema = z.object({
  ocultas: z
    .array(z.enum(CAMPOS))
    .refine((o) => new Set(o).size < CAMPOS.length, 'Deixe pelo menos uma coluna visível'),
});

dashboardRouter.put('/pedidos/colunas', requireAuth, async (req, res, next) => {
  try {
    const parsed = colunasSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const ocultas = [...new Set(parsed.data.ocultas)];
    await pgPool.query(
      `INSERT INTO "UserPreference" ("userId", "key", "value")
       VALUES ($1, $2, $3)
       ON CONFLICT ("userId", "key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = NOW()`,
      [req.user!.id, PREF_COLUNAS, JSON.stringify(ocultas)],
    );
    res.json({ ocultas });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get('/pedidos/:chave', requireAuth, async (req, res, next) => {
  try {
    const chave = String(req.params.chave);
    if (!Object.hasOwn(FILTROS_LISTA, chave)) {
      return res.status(404).json({ message: 'Status não encontrado' });
    }
    const filtro = FILTROS_LISTA[chave];

    const pool = await getPool();
    const [{ recordset }, ocultas] = await Promise.all([
      pool.request().query(pedidosSql(filtro.where)),
      colunasOcultas(req.user!.id),
    ]);

    const obs = await observacoes(recordset.map((r) => String(r.PEDIDO).trim()));

    // Colunas char vêm com espaços à direita.
    const linhas = recordset.map((r) => {
      const linha = Object.fromEntries(
        COLUNAS.map(({ campo }) => [campo, typeof r[campo] === 'string' ? r[campo].trim() : r[campo]]),
      );
      const o = obs.get(String(r.PEDIDO).trim());
      return { ...linha, OBSERVACAO: o?.texto ?? null, OBSERVACAO_POR: o?.por ?? null, OBSERVACAO_EM: o?.em ?? null };
    });

    res.json({ chave, status: filtro.nome, colunas: COLUNAS, ocultas, linhas });
  } catch (err) {
    next(err);
  }
});

// Histórico do objeto direto da API dos Correios (o banco só guarda o último status em CODSRO).
dashboardRouter.get('/rastreio/:codigo', requireAuth, async (req, res, next) => {
  const codigo = String(req.params.codigo).trim().toUpperCase();
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(codigo)) {
    return res.status(400).json({ message: 'Código de rastreio inválido' });
  }
  try {
    res.json(await rastrear(codigo));
  } catch (err) {
    if (err instanceof CorreiosError) return res.status(502).json({ message: err.message });
    next(err);
  }
});
