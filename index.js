import dotenv from 'dotenv'
import pg from 'pg'

const { Pool } = pg;

dotenv.config()

const formioBaseUrl = process.env.FORMIO_BASE_URL;

if (!formioBaseUrl) {
  throw new Error('FORMIO_BASE_URL environment variable is not set');
}

const pool = new Pool()

const insertFormPromise = (form) => async () => {
  if (!form.properties) {
    console.log(`Skipping form without properties (_id=${form._id} path=${form.path})`)
    return Promise.resolve()
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existsRes = await client.query('SELECT id FROM form WHERE path=$1', [form.path]);
    if (existsRes.rows.length) {
      console.log(`[${form.properties.skjemanummer}] Skipping insert, form already exists (dbId=${existsRes.rows[0].id})`)
      return Promise.resolve()
    }
    const res = await client.query(
      'INSERT INTO form(skjemanummer, path, created_by) VALUES($1,$2,$3) RETURNING id',
      [
        form.properties.skjemanummer,
        form.path,
        'IMPORT',
      ]
    )
    const { id } = res.rows[0]
    await client.query(
      'INSERT INTO form_revision(form_id, revision, title, components, properties, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [
        id,
        1,
        form.title,
        JSON.stringify(form.components),
        JSON.stringify(form.properties),
        form.properties.modifiedBy || 'ukjent',
      ]
    )
    await client.query('COMMIT')
    console.log(`[${form.properties.skjemanummer}] Form inserted (dbId=${id})`)

  } catch (e) {
    await client.query('ROLLBACK')
    console.error(`[${form.properties.skjemanummer}] Failed to insert`, e)
  } finally {
    client.release()
  }
  return Promise.resolve()
}

const fetchForms = async () => {
  try {
    const response = await fetch(`${formioBaseUrl}/form?type=form&tag=nav-skjema&limit=200`)
    if (!response.ok) {
      throw new Error(`Failed to fetch forms: ${response.statusText}`)
    }
    return await response.json()
  } catch (err) {
    console.error('Error fetching forms:', err)
    throw err
  }
}

const main = async () => {
  try {
    const forms = await fetchForms()
    const promises = forms.map(form => insertFormPromise(form))
    await Promise.all(promises.map(f => f()))
  } catch (err) {
    console.error('Error processing forms:', err)
  } finally {
    await pool.end()
  }
}

main()
