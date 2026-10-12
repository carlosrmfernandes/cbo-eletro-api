import { getPool } from './db.js';

// API dos Correios (CWS). As credenciais são as mesmas que o ERP usa para gerar as etiquetas:
// ficam em ECOM_CORREIOSSETUP, então não há nada a configurar aqui.
const BASE = 'https://api.correios.com.br';

// Há mais de um cartão cadastrado; o que está em uso é o que o ERP autenticou por último.
const CREDENCIAIS_SQL = `
SELECT TOP 1 RTRIM(USUARIO_API) AS USUARIO, RTRIM(TOKEN_API) AS CODIGO_ACESSO, RTRIM(CARTAO_POSTAGEM) AS CARTAO
FROM dbo.ECOM_CORREIOSSETUP
WHERE NULLIF(RTRIM(USUARIO_API), '') IS NOT NULL AND NULLIF(RTRIM(TOKEN_API), '') IS NOT NULL
ORDER BY DT_EXPIRA DESC;
`;

export class CorreiosError extends Error {}

let token: { valor: string; expira: number } | null = null;

async function autenticar() {
  const pool = await getPool();
  const cred = (await pool.request().query(CREDENCIAIS_SQL)).recordset[0];
  if (!cred) throw new CorreiosError('Credenciais dos Correios não encontradas no sistema');

  const res = await fetch(`${BASE}/token/v1/autentica/cartaopostagem`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cred.USUARIO}:${cred.CODIGO_ACESSO}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ numero: cred.CARTAO }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new CorreiosError('Falha ao autenticar na API dos Correios');

  // expiraEm vem sem fuso ('2026-10-12T13:29:04'); o fuso vem à parte em zoneOffset.
  const expira = Date.parse(`${data.expiraEm}${data.zoneOffset ?? '-03:00'}`);
  token = { valor: data.token, expira: Number.isNaN(expira) ? Date.now() + 30 * 60_000 : expira };
  return token.valor;
}

// Renova com 5 minutos de folga.
async function getToken() {
  if (token && token.expira - Date.now() > 5 * 60_000) return token.valor;
  return autenticar();
}

async function consultar(codigo: string, tokenAtual: string) {
  return fetch(`${BASE}/srorastro/v1/objetos/${codigo}?resultado=T`, {
    headers: { Authorization: `Bearer ${tokenAtual}`, 'Accept-Language': 'pt-BR' },
  });
}

interface Endereco { cidade?: string; uf?: string; bairro?: string; logradouro?: string; numero?: string; cep?: string }
interface Unidade { tipo?: string; endereco?: Endereco }
interface EventoCorreios {
  codigo: string;
  tipo: string;
  dtHrCriado: string;
  descricao: string;
  detalhe?: string;
  unidade?: Unidade;
  unidadeDestino?: Unidade;
  dtLimiteRetirada?: string;
}

const local = (u?: Unidade) => {
  if (!u) return null;
  const cidade = [u.endereco?.cidade, u.endereco?.uf].filter(Boolean).join(' - ');
  // 'INTERFACE DO SISTEMA' / UF 'BR' são eventos gerados pela pré-postagem, sem local físico.
  if (!u.endereco?.cidade && u.endereco?.uf === 'BR') return null;
  return { tipo: u.tipo ?? null, cidade: cidade || null };
};

const enderecoRetirada = (u?: Unidade) => {
  const e = u?.endereco;
  if (!e?.logradouro) return null;
  return [[e.logradouro, e.numero].filter(Boolean).join(', '), e.bairro, [e.cidade, e.uf].filter(Boolean).join(' - ')]
    .filter(Boolean)
    .join(' · ');
};

export async function rastrear(codigo: string) {
  let res = await consultar(codigo, await getToken());
  if (res.status === 401 || res.status === 403) {
    token = null;
    res = await consultar(codigo, await getToken());
  }
  if (!res.ok) throw new CorreiosError('A API dos Correios não respondeu');

  const objeto = (await res.json()).objetos?.[0];
  if (!objeto) throw new CorreiosError('Objeto não encontrado nos Correios');

  const eventos: EventoCorreios[] = objeto.eventos ?? [];
  return {
    codigo: objeto.codObjeto ?? codigo,
    // Ex.: 'SRO-009: Objeto não pertence ao contrato'
    mensagem: objeto.mensagem ?? null,
    servico: objeto.tipoPostal?.categoria ?? null,
    previsaoEntrega: objeto.dtPrevista ?? null,
    peso: objeto.peso ?? null,
    valorDeclarado: objeto.valorDeclarado ?? null,
    // Já vêm do mais recente para o mais antigo.
    eventos: eventos.map((e) => ({
      sro: `${e.codigo}${e.tipo}`,
      data: e.dtHrCriado,
      descricao: e.descricao,
      detalhe: e.detalhe ?? null,
      local: local(e.unidade),
      destino: local(e.unidadeDestino),
      enderecoRetirada: e.dtLimiteRetirada ? enderecoRetirada(e.unidade) : null,
      limiteRetirada: e.dtLimiteRetirada ?? null,
    })),
  };
}
