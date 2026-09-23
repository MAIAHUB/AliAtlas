'use client';
import { useState } from 'react';
import Icon from './Icon.js';

export default function LoginForm() {
  const [mode, setMode] = useState('login'),
    [form, setForm] = useState({ name: '', email: '', password: '' }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const registering = mode === 'register';
  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registering ? form : { email: form.email, password: form.password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Sign-in failed.');
      window.location.replace('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand auth-brand">
          <span className="brand-mark">
            <span>A</span>
            <i />
          </span>
          <span>
            AliAtlas<span className="brand-dot">.</span>
          </span>
        </div>
        <h1>{registering ? 'Create your account' : 'Sign in to your workspace'}</h1>
        <p className="auth-subtitle">
          {registering
            ? 'Your studies and labels are private to your account.'
            : 'Explore CT anatomy, one slice at a time.'}
        </p>
        {registering && (
          <>
            <label className="field-label" htmlFor="auth-name">
              Name
            </label>
            <input
              id="auth-name"
              className="form-input"
              autoComplete="name"
              required
              maxLength={80}
              value={form.name}
              onChange={update('name')}
            />
          </>
        )}
        <label className="field-label" htmlFor="auth-email">
          Email
        </label>
        <input
          id="auth-email"
          className="form-input"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={form.email}
          onChange={update('email')}
        />
        <label className="field-label" htmlFor="auth-password">
          Password
        </label>
        <input
          id="auth-password"
          className="form-input"
          type="password"
          autoComplete={registering ? 'new-password' : 'current-password'}
          required
          minLength={registering ? 10 : undefined}
          maxLength={200}
          value={form.password}
          onChange={update('password')}
        />
        {registering && <p className="form-hint">At least 10 characters.</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button auth-submit" disabled={busy}>
          {busy ? <span className="spinner small" /> : <Icon name="lock" size={15} />}
          {registering ? 'Create account' : 'Sign in'}
        </button>
        <p className="auth-switch">
          {registering ? 'Already have an account?' : 'New to AliAtlas?'}{' '}
          <button
            type="button"
            className="text-button accent"
            onClick={() => {
              setMode(registering ? 'login' : 'register');
              setError('');
            }}
          >
            {registering ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
    </main>
  );
}
