import { db, withTx, type Q, type Emit } from '../db.js';
import { AppError } from '../errors.js';
import { audit } from '../audit.js';
import { config } from '../config.js';

export interface Actor { id: string; role: 'MANAGER' | 'STAFF'; requestId?: string; }

const bump = async (c: Q, emit: Emit) => {
  const r = await c.query<{ value: string }>(
    `UPDATE app_settings SET value = (value::int + 1)::text WHERE key = 'menu_version' RETURNING value`);
  emit('menu.updated', { version: Number(r.rows[0].value) }, { publicMenu: true, staff: true });
};

export async function menuVersion(): Promise<number> {
  return Number((await db.query<{ value: string }>(`SELECT value FROM app_settings WHERE key='menu_version'`)).rows[0].value);
}

const itemCols = `i.id, i.section_id AS "sectionId", i.name, i.description, i.food_type AS "foodType",
  i.price, i.tax_rate AS "taxRate", i.is_available AS "isAvailable", i.is_active AS "isActive",
  i.image_url AS "imageUrl", i.sort_order AS "sortOrder"`;

/** What customers see: only active sections and active items. Always read fresh from the database. */
export async function publicMenu() {
  const sections = (await db.query(
    `SELECT id, name, description FROM menu_sections WHERE is_active ORDER BY sort_order, created_at`)).rows;
  const items = (await db.query(
    `SELECT ${itemCols} FROM menu_items i JOIN menu_sections s ON s.id = i.section_id
     WHERE i.is_active AND s.is_active ORDER BY i.sort_order, i.created_at`)).rows;
  return {
    version: await menuVersion(),
    sections: sections.map((s: any) => ({ ...s, items: items.filter((i: any) => i.sectionId === s.id) }))
      .filter((s: any) => s.items.length > 0),
  };
}

/** What staff/manager see: everything, including hidden things. */
export async function fullMenu() {
  const sections = (await db.query(
    `SELECT id, name, description, sort_order AS "sortOrder", is_active AS "isActive"
     FROM menu_sections ORDER BY sort_order, created_at`)).rows;
  const items = (await db.query(`SELECT ${itemCols} FROM menu_items i ORDER BY i.sort_order, i.created_at`)).rows;
  return { version: await menuVersion(), sections: sections.map((s: any) => ({ ...s, items: items.filter((i: any) => i.sectionId === s.id) })) };
}

export function checkTax(rate: number) {
  if (rate < 0 || rate > config.maxTaxRate)
    throw new AppError('VALIDATION_ERROR', `Tax must be between 0 and ${config.maxTaxRate} percent.`);
}

export async function createSection(a: Actor, d: { name: string; description?: string | null }) {
  return withTx(async (c, emit) => {
    try {
      const max = (await c.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM menu_sections`)).rows[0].n;
      const r = await c.query(
        `INSERT INTO menu_sections (name, description, sort_order) VALUES ($1,$2,$3) RETURNING id`,
        [d.name.trim(), d.description ?? null, max]);
      await audit(c, { actor: a.id, action: 'MENU_SECTION_CREATED', entityType: 'menu_section', entityId: r.rows[0].id, newValue: d, requestId: a.requestId });
      await bump(c, emit);
      return r.rows[0].id as string;
    } catch (e: any) {
      if (String(e?.message).includes('menu_sections_active_name')) throw new AppError('VALIDATION_ERROR', 'A section with this name already exists.');
      throw e;
    }
  });
}

export async function updateSection(a: Actor, id: string, d: { name?: string; description?: string | null; sortOrder?: number; isActive?: boolean }) {
  return withTx(async (c, emit) => {
    const old = (await c.query(`SELECT name, description, sort_order, is_active FROM menu_sections WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new AppError('NOT_FOUND', 'Section not found.');
    try {
      await c.query(
        `UPDATE menu_sections SET name=COALESCE($2,name), description=CASE WHEN $3::boolean THEN $4 ELSE description END,
         sort_order=COALESCE($5,sort_order), is_active=COALESCE($6,is_active), updated_at=now() WHERE id=$1`,
        [id, d.name?.trim() ?? null, d.description !== undefined, d.description ?? null, d.sortOrder ?? null, d.isActive ?? null]);
    } catch (e: any) {
      if (String(e?.message).includes('menu_sections_active_name')) throw new AppError('VALIDATION_ERROR', 'A section with this name already exists.');
      throw e;
    }
    await audit(c, { actor: a.id, action: d.isActive === false ? 'MENU_SECTION_HIDDEN' : 'MENU_SECTION_UPDATED', entityType: 'menu_section', entityId: id, oldValue: old, newValue: d, requestId: a.requestId });
    await bump(c, emit);
  });
}

export interface ItemInput {
  sectionId: string; name: string; description?: string | null; foodType: 'VEG' | 'NON_VEG' | 'EGG';
  price: string; taxRate: number; isAvailable?: boolean; imageUrl?: string | null;
}

export async function createItem(a: Actor, d: ItemInput) {
  checkTax(d.taxRate);
  return withTx(async (c, emit) => {
    const s = (await c.query(`SELECT 1 FROM menu_sections WHERE id=$1`, [d.sectionId])).rows[0];
    if (!s) throw new AppError('NOT_FOUND', 'Section not found.');
    const max = (await c.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM menu_items WHERE section_id=$1`, [d.sectionId])).rows[0].n;
    const r = await c.query(
      `INSERT INTO menu_items (section_id,name,description,food_type,price,tax_rate,is_available,image_url,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [d.sectionId, d.name.trim(), d.description ?? null, d.foodType, d.price, d.taxRate, d.isAvailable ?? true, d.imageUrl ?? null, max]);
    await audit(c, { actor: a.id, action: 'MENU_ITEM_CREATED', entityType: 'menu_item', entityId: r.rows[0].id, newValue: d, requestId: a.requestId });
    await bump(c, emit);
    return r.rows[0].id as string;
  });
}

export async function updateItem(a: Actor, id: string, d: Partial<ItemInput> & { sortOrder?: number; isActive?: boolean }) {
  if (d.taxRate !== undefined) checkTax(d.taxRate);
  return withTx(async (c, emit) => {
    const old = (await c.query(`SELECT name, section_id, price, tax_rate, food_type, is_available, is_active FROM menu_items WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new AppError('NOT_FOUND', 'Item not found.');
    await c.query(
      `UPDATE menu_items SET section_id=COALESCE($2,section_id), name=COALESCE($3,name),
        description=CASE WHEN $4::boolean THEN $5 ELSE description END, food_type=COALESCE($6,food_type),
        price=COALESCE($7,price), tax_rate=COALESCE($8,tax_rate), is_available=COALESCE($9,is_available),
        is_active=COALESCE($10,is_active), image_url=CASE WHEN $11::boolean THEN $12 ELSE image_url END,
        sort_order=COALESCE($13,sort_order), updated_at=now() WHERE id=$1`,
      [id, d.sectionId ?? null, d.name?.trim() ?? null, d.description !== undefined, d.description ?? null,
       d.foodType ?? null, d.price ?? null, d.taxRate ?? null, d.isAvailable ?? null, d.isActive ?? null,
       d.imageUrl !== undefined, d.imageUrl ?? null, d.sortOrder ?? null]);
    const action = d.isActive === false ? 'MENU_ITEM_HIDDEN'
      : d.price !== undefined && String(Number(d.price)) !== String(Number(old.price)) ? 'MENU_ITEM_PRICE_CHANGED' : 'MENU_ITEM_UPDATED';
    await audit(c, { actor: a.id, action, entityType: 'menu_item', entityId: id, oldValue: old, newValue: d, requestId: a.requestId });
    await bump(c, emit);
  });
}

export async function sortMenu(a: Actor, d: { type: 'sections' | 'items'; ids: string[] }) {
  return withTx(async (c, emit) => {
    const table = d.type === 'sections' ? 'menu_sections' : 'menu_items';
    for (let i = 0; i < d.ids.length; i++) await c.query(`UPDATE ${table} SET sort_order=$2, updated_at=now() WHERE id=$1`, [d.ids[i], i + 1]);
    await audit(c, { actor: a.id, action: 'MENU_REORDERED', entityType: table, entityId: 'bulk', newValue: d.ids, requestId: a.requestId });
    await bump(c, emit);
  });
}
