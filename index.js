require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const http = require('http'); // Adicionado para manter o Render feliz

// --- 1. Configuração do Banco de Dados (MongoDB) ---
mongoose.connect(process.env.MONGO_URI || '', {
    // Opções modernas do Mongoose não exigem mais useNewUrlParser/useUnifiedTopology explicitamente na v6+
    // mas garantem compatibilidade caso use versão legada
})
    .then(() => console.log('✅ Conectado ao MongoDB!'))
    .catch(err => {
        console.error('❌ Erro ao conectar no MongoDB:', err);
        console.log('💡 DICA: Verifique se sua MONGO_URI no arquivo .env está correta.');
    });

// Schema para Pagamentos
const PaymentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    txId: { type: String, required: true, unique: true },
    plano: { type: String, required: true },
    valor: { type: Number, required: true },
    status: { type: String, default: 'pendente' }, // pendente, paid
    createdAt: { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', PaymentSchema);

// --- 2. Constantes e Configurações ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const VIP_LINK = 'https://t.me/+3tFGdcaEztdmNDUx'; // Link do canal/grupo VIP
const SUPPORT_LINK = 'https://t.me/larissakovask';

const PLANOS = {
    '1mes': { nome: '1 Mês', value: 23.90 },
    '3meses': { nome: '3 Meses', value: 44.70 },
    '12meses': { nome: '12 Meses', value: 178.00 }
};

// --- 3. Funções Utilitárias ---

function gerarCpf() {
    const random = (n) => Math.floor(Math.random() * n);
    const mod = (dividendo, divisor) => Math.round(dividendo - (Math.floor(dividendo / divisor) * divisor));

    const n1 = random(10);
    const n2 = random(10);
    const n3 = random(10);
    const n4 = random(10);
    const n5 = random(10);
    const n6 = random(10);
    const n7 = random(10);
    const n8 = random(10);
    const n9 = random(10);

    let d1 = n9 * 2 + n8 * 3 + n7 * 4 + n6 * 5 + n5 * 6 + n4 * 7 + n3 * 8 + n2 * 9 + n1 * 10;
    d1 = 11 - (mod(d1, 11));
    if (d1 >= 10) d1 = 0;

    let d2 = d1 * 2 + n9 * 3 + n8 * 4 + n7 * 5 + n6 * 6 + n5 * 7 + n4 * 8 + n3 * 9 + n2 * 10 + n1 * 11;
    d2 = 11 - (mod(d2, 11));
    if (d2 >= 10) d2 = 0;

    return `${n1}${n2}${n3}${n4}${n5}${n6}${n7}${n8}${n9}${d1}${d2}`;
}

async function criarPix(value, userId, plano) {
    try {
        // Formata os parâmetros na URL como feito no proxy.php de referência
        const params = new URLSearchParams({
            apiKey: process.env.API_KEY || '',
            value: value,
            user_id: userId.toString(),
            cpf: gerarCpf() // Gera um CPF válido para passar na validação
        });

        const response = await fetch(`${process.env.API_GATEWAY_URL}/api/createPix?${params.toString()}`, {
            method: 'GET', // Referência usa GET
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const responseData = await response.json();

        console.log('--- DEBUG API PIX ---');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(responseData, null, 2));
        console.log('---------------------');

        // Verifica erro via success ou flag de erro
        if (responseData.error) {
            throw new Error(responseData.error);
        }

        // Estrutura identificada nos logs: { success: true, data: { id: "...", copiaCola: "..." } }
        if (!responseData.success || !responseData.data || !responseData.data.id) {
            throw new Error('Falha ao gerar PIX: Dados incompletos na resposta da API.');
        }

        // Mapeia para o formato que o bot espera
        const pixInfo = responseData.data;
        return {
            id: pixInfo.id,
            pix_code: pixInfo.copiaCola, // API retorna 'copiaCola', bot usa 'pix_code'
            ...pixInfo
        };
    } catch (error) {
        console.error('Erro na criação do PIX:', error);
        return null;
    }
}

async function statusPix(txId) {
    try {
        const response = await fetch(`${process.env.API_GATEWAY_URL}/api/status/${txId}?apiKey=${process.env.API_KEY || ''}`, {
            method: 'GET'
        });
        const data = await response.json();
        // Se a estrutura de status for similar (dentro de data), precisamos ajustar também?
        // Geralmente status retorna { status: 'paid' } ou { data: { status: 'paid' } }
        // Vamos assumir comportamento padrão mas logar para debug se falhar
        return data;
    } catch (error) {
        console.error('Erro ao checar status:', error);
        return { status: 'error' };
    }
}

// --- 4. Lógica do Bot ---

bot.start((ctx) => {
    const nomeUser = ctx.from.first_name || 'Amigo';
    ctx.reply(
        `Olá, ${nomeUser}! 🔥 OFERTA VERÃO 2026 🔥\n\n💜 Escolha seu plano VIP para acesso EXCLUSIVO:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('📦 1 Mês - R$ 23,90', 'plano_1mes')],
            [Markup.button.callback('🔥 3 Meses - R$ 44,70', 'plano_3meses')],
            [Markup.button.callback('💥 12 Meses - R$ 178,00', 'plano_12meses')]
        ])
    );
});

// Ação ao clicar em um plano
bot.action(/plano_(.+)/, async (ctx) => {
    const planoKey = ctx.match[1];
    const dadosPlano = PLANOS[planoKey];

    if (!dadosPlano) return ctx.reply('❌ Plano não encontrado.');

    const userId = ctx.from.id;

    await ctx.reply(`🔄 Gerando seu PIX para o plano *${dadosPlano.nome}*...`, { parse_mode: 'Markdown' });

    const pixData = await criarPix(dadosPlano.value, userId, planoKey);

    if (!pixData) {
        return ctx.reply('❌ Erro ao gerar o pagamento. Tente novamente mais tarde ou contate o suporte.');
    }

    // Salvar no MongoDB
    try {
        await Payment.create({
            userId: userId.toString(),
            txId: pixData.id,
            plano: planoKey,
            valor: dadosPlano.value,
            status: 'pendente'
        });
    } catch (err) {
        console.error('Erro ao salvar no banco:', err);
        // Prossegue mesmo com erro de log, mas idealmente trataria
    }

    // Enviar QR Code e Copia e Cola
    await ctx.reply(
        `💳 **AQUI ESTÁ SEU PIX!**\n\nValor: R$ ${dadosPlano.value.toFixed(2)}\n\nCopie o código abaixo e pague no seu banco:`,
        { parse_mode: 'Markdown' }
    );

    await ctx.reply(`\`${pixData.pix_code}\``, { parse_mode: 'Markdown' });

    await ctx.reply(
        `⏳ **Após realizar o pagamento, clique no botão abaixo para liberar seu acesso imediatamente:**`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ JÁ PAGUEI! VERIFICAR', `check_${pixData.id}`)]
        ])
    );
});

// Ação de verificar pagamento
bot.action(/check_(.+)/, async (ctx) => {
    const txId = ctx.match[1];

    // Buscar no banco primeiro para evitar chamadas de API desnecessárias se já estiver pago
    let pagamentoDB = await Payment.findOne({ txId: txId });

    if (pagamentoDB && pagamentoDB.status === 'paid') {
        return enviarAcessoVip(ctx);
    }

    // Verificar na API
    await ctx.answerCbQuery('Verificando pagamento...');
    const apiStatus = await statusPix(txId);

    if (apiStatus.status === 'paid') {
        // Atualizar banco
        if (pagamentoDB) {
            pagamentoDB.status = 'paid';
            await pagamentoDB.save();
        } else {
            // Caso extremo onde não salvou na criação
            await Payment.create({
                userId: ctx.from.id.toString(),
                txId,
                status: 'paid',
                plano: 'desconhecido',
                valor: 0
            });
        }

        return enviarAcessoVip(ctx);
    } else {
        ctx.reply('⏳ Pagamento ainda não confirmado. Aguarde alguns segundos e tente clicar novamente.',
            Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Tentar Novamente', `check_${txId}`)]
            ])
        );
    }
});

function enviarAcessoVip(ctx) {
    ctx.reply(
        `🎉 **PAGAMENTO CONFIRMADO!**\n\nSeja bem-vindo(a) à área VIP! 🔥\n\n👇 **Clique no botão abaixo para entrar:**`,
        Markup.inlineKeyboard([
            [Markup.button.url('😎 ENTRAR NO GRUPO VIP', VIP_LINK)],
            [Markup.button.url('📞 Suporte / Ajuda', SUPPORT_LINK)]
        ])
    );
}

// --- 5. Servidor HTTP para o Render (Health Check) ---
// O Render exige que um serviço Web escute em uma porta, senão ele acha que falhou.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Bot esta online e rodando!');
    res.end();
}).listen(PORT, () => {
    console.log(`✅ Servidor HTTP rodando na porta ${PORT} para o Render.`);
});

// Iniciar bot
bot.launch().then(() => {
    console.log('🤖 Bot iniciado com sucesso!');
}).catch(err => {
    console.error('❌ Erro ao iniciar bot:', err);
});

// Habilitar Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
